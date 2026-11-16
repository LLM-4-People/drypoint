/**
 * Device manager: owns the transport, the session and the discovered
 * capabilities. Everything the UI knows about the printer comes from here.
 */

import { CONFIG } from '../core/config.js';
import { createEmitter } from '../core/events.js';
import { setGeometry } from '../core/geometry.js';
import { createLogger } from '../core/log.js';
import { getSetting, printSettingsSnapshot, setSetting } from '../core/settings.js';
import { Session } from '../protocol/session.js';
import { ProtocolClient } from '../protocol/client.js';
import { INFO_KEYS } from '../protocol/commands.js';
import { decodeInfo } from '../protocol/replies.js';
import { PrinterError, abortReason } from '../protocol/errors.js';
import { emptyCapabilities, mergeCapabilities, clearVolatileCapabilities, applyHeartbeatSample, clampToRange, printBlockReason, CONNECTION_STATUSES } from './capabilities.js';
import { runPrintJob } from './print-job.js';
import { resolvePrintOptions } from './print-options.js';
import { transportCandidates } from './transports/index.js';
import { getRollProfile, rememberRoll } from './roll-profiles.js';

const log = createLogger('device');

/**
 * One projection table for every GetInfo key this codebase can decode.
 *
 * `field` names the capability the decoded value feeds during discovery.
 * `'diagnostic'` means nothing consumes it automatically, so discovery never
 * spends a round-trip on it; the value stays available through
 * `readInfoDiagnostics()` and the Print panel's "Read device info" action.
 *
 * A key may appear exactly once. The consumer matrix test enforces that every
 * probe has a consumer, that every capability field is a real key of the model,
 * and that diagnostic keys are never probed.
 */
export const INFO_PROJECTION = Object.freeze([
  { key: INFO_KEYS.modelId, name: 'Model', field: 'model' },
  { key: INFO_KEYS.serial, name: 'Serial', field: 'serial' },
  { key: INFO_KEYS.density, name: 'Density', field: 'density' },
  { key: INFO_KEYS.labelType, name: 'Tape type', field: 'labelType' },
  { key: INFO_KEYS.autoShutdown, name: 'Auto power-off', field: 'autoShutdown' },
  { key: INFO_KEYS.battery, name: 'Battery', field: 'battery' },
  { key: INFO_KEYS.softwareVersion, name: 'Firmware', field: 'firmware' },
  { key: INFO_KEYS.hardwareVersion, name: 'Hardware version', field: 'hardware' },
  // Decodable but consumed by nothing during discovery.
  { key: INFO_KEYS.speed, name: 'Job speed', field: 'diagnostic' },
  { key: INFO_KEYS.headWidth, name: 'Head width', field: 'diagnostic' },
  { key: INFO_KEYS.accuracy, name: 'Accuracy', field: 'diagnostic' },
  { key: INFO_KEYS.language, name: 'Language', field: 'diagnostic' },
  { key: INFO_KEYS.bluetoothAddress, name: 'Bluetooth address', field: 'diagnostic' },
  { key: INFO_KEYS.printMode, name: 'Printer print mode', field: 'diagnostic' },
  { key: INFO_KEYS.area, name: 'Print area', field: 'diagnostic' },
]);

/** The keys discovery reads: exactly the projection entries with a consumer. */
export const INFO_PROBES = Object.freeze(
  INFO_PROJECTION.filter(({ field }) => field !== 'diagnostic').map(({ key }) => key)
);

/** The keys only the explicit diagnostic action reads. */
export const DIAGNOSTIC_INFO_KEYS = Object.freeze(
  INFO_PROJECTION.filter(({ field }) => field === 'diagnostic').map(({ key }) => key)
);

/**
 * @param {{candidates?: typeof transportCandidates}} [options] transport resolver
 *        (injectable so lifecycle tests do not need a real browser transport)
 */
export function createDeviceManager({ candidates = transportCandidates } = {}) {
  const events = createEmitter();
  /** One close promise per transport, shared by every caller that disposes it. */
  const disposals = new WeakMap();
  /** Sessions this module closed on purpose; only they log at info, not warn. */
  const expectedCloses = new WeakSet();
  let state = {
    status: 'idle',
    transportKind: null,
    transportLabel: null,
    capabilities: emptyCapabilities(),
    error: null,
    progress: null,
    /** A print job owns the link; the panel disables device commands. */
    printing: false,
    /** An explicit diagnostic read owns the link; Print waits for it. */
    readingInfo: false,
  };
  let transport = null;
  let session = null;
  let client = null;
  /** The newest connect attempt: only one that still owns the generation may run. */
  let connecting = null;
  let currentJob = null;
  /** A transport open() in flight: the instance and its per-attempt abort. */
  let pendingOpen = null;
  /** The session that was published as connected; only it can emit `disconnected`. */
  let connectedSession = null;
  /** One discovery per session: connect, refresh, reset and post-print share it. */
  let discovery = null;
  /** One diagnostic read per session: a second caller joins it. */
  let diagnostics = null;
  /** Bumped by every connect attempt and by disconnect: the newest one owns the link. */
  let generation = 0;

  const update = (patch) => {
    // The status table is the single owner of what the header and the panel
    // can render; an undeclared state must fail here, not fall back to Offline.
    if (patch.status !== undefined && !CONNECTION_STATUSES.includes(patch.status)) {
      throw new PrinterError(`Unknown device status: ${patch.status}`);
    }
    state = { ...state, ...patch };
    events.emit('state', state);
    return state;
  };

  /**
   * Close a transport exactly once, whatever path asked for it.
   *
   * A close() that never settles must not wedge every later connection: the
   * disposal is bounded, and a timed-out close is a warning, not a hang.
   */
  function disposeTransport(target) {
    if (!target) return Promise.resolve();
    const existing = disposals.get(target);
    if (existing) return existing;
    const timeoutMs = CONFIG.transport.closeTimeoutMs;
    const disposal = (async () => {
      let timer;
      try {
        await Promise.race([
          target.close(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new PrinterError(`The transport did not close within ${timeoutMs} ms`, { timeout: true })), timeoutMs);
            timer?.unref?.();
          }),
        ]);
      } catch (error) {
        if (error.timeout) log.warn('transport close timed out', { timeoutMs, message: error.message });
        else log.debug('transport close failed', { message: error.message });
      } finally {
        clearTimeout(timer);
      }
    })();
    disposals.set(target, disposal);
    return disposal;
  }

  function attach(nextTransport, kind) {
    transport = nextTransport;
    const nextSession = new Session(nextTransport, { name: `session.${kind}` });
    session = nextSession;
    client = new ProtocolClient(nextSession);
    nextSession.events.on('closed', (error) => {
      // A stale session must never tear down the connection that replaced it.
      if (session !== nextSession) return;
      void handleClosed(nextSession, error);
    });
    nextSession.events.on('error', (error) => {
      if (session !== nextSession) return;
      // While a job owns the link it is the error's single owner: it aborts
      // with this error and its caller reports once. Only an unsolicited error
      // on an idle link reaches the main error channel.
      if (currentJob) return;
      events.emit('printer-error', error);
    });
  }

  async function handleClosed(closedSession, error) {
    if (session !== closedSession) return;
    const wasConnected = connectedSession === closedSession;
    connectedSession = null;
    // A close this module asked for is an operator outcome, not a fault. The
    // marker is per session, so a stale close cannot silence a later real drop.
    if (expectedCloses.has(closedSession)) {
      expectedCloses.delete(closedSession);
      log.info('session closed', { wasConnected });
    } else {
      log.warn('session closed', { message: error?.message, wasConnected });
    }
    currentJob = null;
    // The link is gone: release every reference before the (bounded) close
    // await, so a connect() issued from the state event starts clean.
    const closingTransport = transport;
    session = null;
    client = null;
    transport = null;
    // Battery, sensors and the roll tag described the link that just ended;
    // identity, features and geometry stay as learned.
    update({
      status: 'idle',
      error: null,
      transportKind: null,
      transportLabel: null,
      progress: null,
      printing: false,
      readingInfo: false,
      capabilities: clearVolatileCapabilities(state.capabilities),
    });
    // A link that never reached "connected" (cancelled or failed connect) has
    // no connection to lose; the connect() caller reports its own error.
    if (wasConnected) events.emit('disconnected', error);
    await disposeTransport(closingTransport);
  }

  /** Optional probe: an unsupported command or a timeout is diagnostic only. */
  async function probe(activeClient, name, options) {
    return activeClient.tryQuery(name, {}, options);
  }

  /** Optional GetInfo read against the discovery's own client. */
  async function readInfo(activeClient, key, options) {
    const data = await activeClient.tryRequest('getInfo', { key }, options);
    return data === null ? null : decodeInfo(key, data);
  }

  /**
   * Read the GetInfo keys discovery deliberately does not probe. They are
   * decodable but nothing consumes them, so they cost a round-trip only when an
   * operator explicitly asks for them. The same discovery deadline bounds the
   * whole read: a silent printer must not hold the panel open.
   *
   * One promise per read: a second click joins the read already in progress
   * instead of queueing another fourteen exchanges into the same stream, and
   * `readingInfo` is published synchronously so print() sees the lock.
   */
  function readInfoDiagnostics() {
    assertConnected();
    if (diagnostics?.session === session) return diagnostics.promise;
    assertIdle();
    const activeSession = session;
    update({ readingInfo: true });
    const promise = runInfoDiagnostics().finally(() => {
      if (diagnostics?.promise === promise) diagnostics = null;
      update({ readingInfo: false });
    });
    diagnostics = { session: activeSession, promise };
    return promise;
  }

  async function runInfoDiagnostics() {
    const deadlineMs = CONFIG.protocol.timeouts.discovery;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const expired = () => new PrinterError(`The printer did not finish the info read within ${deadlineMs} ms`, { timeout: true });
    try {
      const entries = [];
      for (const { key, name } of INFO_PROJECTION) {
        if (!DIAGNOSTIC_INFO_KEYS.includes(key)) continue;
        // Defence in depth: the flag set above already refuses a concurrent
        // print, so this only fires if that lock is ever bypassed.
        if (state.printing) throw new PrinterError('A print job is running; wait for it to finish');
        const data = await client.tryRequest('getInfo', { key }, { signal: controller.signal });
        if (controller.signal.aborted) throw expired();
        entries.push({ key, name, decoded: data === null ? null : decodeInfo(key, data) });
      }
      return entries;
    } catch (error) {
      if (controller.signal.aborted && error?.cancelled) throw expired();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read everything the printer is willing to tell us.
   *
   * One promise per session: refresh, reset and the post-print refresh join the
   * discovery that is already running instead of publishing a second, older
   * model when they finish later. A single deadline bounds the whole pass, so
   * a silent printer cannot hold the job lock (or the Connect button) open.
   *
   * The session and client are captured once: every probe runs against that
   * pair, so a reconnect mid-discovery can never mix two sessions. Optional
   * probes go through tryQuery (unsupported/timeout → null) and a fatal error
   * (the link died) propagates, so a dead link cannot resolve as "connected".
   */
  function discover() {
    const activeSession = session;
    const activeClient = client;
    if (!activeSession || !activeClient) return Promise.reject(new PrinterError('Printer is not connected'));
    if (discovery && discovery.session === activeSession) return discovery.promise;
    const promise = runDiscovery(activeSession, activeClient).finally(() => {
      if (discovery?.promise === promise) discovery = null;
    });
    discovery = { session: activeSession, promise };
    return promise;
  }

  async function runDiscovery(activeSession, activeClient) {
    const started = Date.now();
    const deadlineMs = CONFIG.protocol.timeouts.discovery;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const options = { signal: controller.signal };
    const expired = () => new PrinterError(`The printer did not finish discovery within ${deadlineMs} ms`, { timeout: true });
    try {
      const statusData = await probe(activeClient, 'statusData', options);
      const heartbeat = await probe(activeClient, 'heartbeatInfo', options);
      const capabilities = await probe(activeClient, 'capabilities', options);
      const advanced = await probe(activeClient, 'heartbeatAdvanced', options);

      if (!statusData && !heartbeat && !capabilities) {
        throw new PrinterError('The printer did not answer any capability probe');
      }

      const info = {};
      for (const key of INFO_PROBES) Object.assign(info, (await readInfo(activeClient, key, options)) ?? {});

      const roll = await probe(activeClient, 'rfid', options);

      // Publishing "connected" is the one irreversible step: only do it while the
      // session that answered is still the current, open one.
      if (session !== activeSession || client !== activeClient || activeSession.closed) {
        throw new PrinterError('Discovery was superseded by a reconnect');
      }
      if (controller.signal.aborted) throw expired();

      const merged = mergeCapabilities({
        heartbeat,
        advanced,
        capabilities,
        statusData,
        info,
        roll,
        // Only the session that was already published may seed the merge; a new
        // connection starts from defaults, never from the previous printer.
        previous: connectedSession === activeSession ? state.capabilities : null,
      });
      setGeometry(merged);
      applyDetectedSettings(merged);
      connectedSession = activeSession;
      log.info('discovered', {
        model: merged.model,
        firmware: merged.firmware,
        protocol: merged.protocolVersion,
        labels: merged.labelTypes,
        remaining: merged.roll?.remaining,
        ms: Date.now() - started,
      });
      update({ capabilities: merged, status: 'connected', error: null });
      events.emit('discovered', merged);
      return merged;
    } catch (error) {
      // The deadline aborts the in-flight exchange; report it as the discovery
      // failure it is, not as a user cancel.
      if (controller.signal.aborted && error?.cancelled) throw expired();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Install one transport candidate, bounded by CONFIG.transport.openTimeoutMs
   * and cancellable by disconnect(). `open()` may never settle (a GATT connect
   * that stalls, a port the OS holds), and nothing is attached yet, so without
   * this bound the attempt would hold the manager forever.
   */
  async function openInstance(instance, target, attempt) {
    const controller = new AbortController();
    const timeoutMs = CONFIG.transport.openTimeoutMs;
    const cancelledOpen = () => new PrinterError('Connection attempt was cancelled', { cancelled: true });
    pendingOpen = { attempt, instance, controller };
    let timer;
    try {
      await Promise.race([
        instance.open(target),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new PrinterError(`The transport did not open within ${timeoutMs} ms`, { timeout: true })), timeoutMs);
          timer?.unref?.();
        }),
        new Promise((_, reject) => {
          if (controller.signal.aborted) reject(cancelledOpen());
          else controller.signal.addEventListener('abort', () => reject(cancelledOpen()), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (pendingOpen?.controller === controller) pendingOpen = null;
    }
  }

  async function openTransport(preference, { auto = false, choose = false } = {}, attempt) {
    const errors = [];
    for (const Transport of candidates(preference)) {
      if (!Transport.available()) continue;
      const instance = new Transport();
      try {
        // Auto-connect must never prompt: a permission request needs a user
        // gesture, so it only ever attaches to an already-granted device.
        // "Choose printer" is the explicit opposite: it always asks the user.
        const target = choose ? await Transport.request() : auto ? await Transport.granted() : (await Transport.granted()) ?? (await Transport.request());
        if (!target) {
          errors.push(new PrinterError(choose ? 'No printer selected' : 'No granted printer is available', { cancelled: true }));
          continue;
        }
        await openInstance(instance, target, attempt);
        attach(instance, instance.kind);
        update({ transportKind: instance.kind, transportLabel: instance.describe() });
        return instance;
      } catch (error) {
        errors.push(error);
        await disposeTransport(instance);
      }
    }
    const last = errors.at(-1);
    if (last?.name === 'NotFoundError') throw new PrinterError('No printer selected', { cancelled: true });
    throw last ?? new PrinterError('No compatible transport is available on this device');
  }

  async function connect({ preference = getSetting('device.transport'), auto = false, choose = false } = {}) {
    if (state.status === 'connected') return state.capabilities;
    // Join only the attempt that still owns the connection generation: after a
    // disconnect a stale attempt is dead, and joining it would make every later
    // click a silent no-op.
    if (connecting && connecting.attempt === generation) return connecting.promise;
    const attempt = ++generation;
    update({ status: 'connecting', error: null });
    const promise = (async () => {
      try {
        await openTransport(preference, { auto, choose }, attempt);
        // disconnect() while open() was pending cancels this attempt: it must
        // not reconnect or publish over the state the user asked for.
        if (attempt !== generation) throw new PrinterError('Connection attempt was cancelled', { cancelled: true });
        return await discover();
      } catch (error) {
        // A cancelled picker, an auto-connect with no granted device, or a
        // disconnect during open() is a normal outcome, not a reported error.
        const superseded = attempt !== generation;
        const quiet = superseded || error.cancelled === true;
        if (quiet) log.debug('connect cancelled', { message: error.message });
        else log.error('connect failed', { message: error.message });
        await safeClose();
        // A newer connection may have attached while this one was tearing down.
        if (!session) {
          update({ status: quiet ? 'idle' : 'error', error: quiet ? null : error.message, transportKind: null });
        }
        throw error;
      } finally {
        // Clear only this attempt's entry; a superseding connect owns its own.
        if (connecting?.promise === promise) connecting = null;
      }
    })();
    connecting = { attempt, promise };
    return promise;
  }

  /** Mirror the printer's own settings into the app (auto-detect). */
  function applyDetectedSettings(capabilities) {
    if (!getSetting('device.readSettings')) return;
    if (capabilities.density != null) {
      setSetting('print.density', clampToRange(capabilities.density, capabilities.densityRange, CONFIG.print.density.default));
    }
    const detectedType = capabilities.labelType ?? capabilities.roll?.type;
    if (detectedType && capabilities.labelTypes.includes(detectedType)) {
      setSetting('print.labelType', String(detectedType));
    }
    const profile = getRollProfile(capabilities.roll?.barcode);
    if (profile) {
      events.emit('roll-profile', profile);
    }
  }

  async function safeClose() {
    const closingSession = session;
    const closingTransport = transport;
    // Mark before close(): the session emits `closed` synchronously, and only a
    // deliberate close may log at info instead of warning about a lost link.
    if (closingSession) expectedCloses.add(closingSession);
    try {
      closingSession?.close();
    } catch (error) {
      log.debug('session close failed', { message: error.message });
    }
    if (session === closingSession) {
      session = null;
      client = null;
    }
    if (transport === closingTransport) transport = null;
    await disposeTransport(closingTransport);
  }

  async function disconnect() {
    // Cancel every attempt that is still opening its transport: abort the
    // race, dispose the half-open instance (idempotent) and ignore its result.
    generation += 1;
    const opening = pendingOpen;
    if (opening) {
      pendingOpen = null;
      opening.controller.abort();
      await disposeTransport(opening.instance);
    }
    await safeClose();
    // A concurrent connect may already own a fresh session; never clobber it.
    if (session) return;
    update({
      status: 'idle',
      transportKind: null,
      transportLabel: null,
      error: null,
      progress: null,
      printing: false,
      readingInfo: false,
      capabilities: clearVolatileCapabilities(state.capabilities),
    });
  }

  /**
   * Ask the user which printer to use. Deliberately separate from connect(): a
   * normal connect stays one tap on the last granted device, while this action
   * always opens the browser or native picker.
   */
  async function choosePrinter({ preference = getSetting('device.transport') } = {}) {
    if (state.status === 'connecting') throw new PrinterError('Wait for the current connection attempt to finish');
    if (state.status === 'connected' || session) await disconnect();
    return connect({ preference, choose: true });
  }

  /**
   * Forget the device the app may reconnect to on its own. Only a transport
   * that owns a saved selection (the Android bridge's lastDevice) can clear it;
   * a browser port permission belongs to the browser and page script cannot
   * revoke it, which the panel states honestly.
   */
  async function forgetPrinter({ preference = getSetting('device.transport') } = {}) {
    if (state.status === 'connecting') throw new PrinterError('Wait for the current connection attempt to finish');
    if (state.status === 'connected' || session) await disconnect();
    const results = [];
    for (const Transport of candidates(preference)) {
      if (!Transport.available() || typeof Transport.forget !== 'function') continue;
      try {
        const forgotten = (await Transport.forget()) !== false;
        results.push({ transport: Transport.name, forgotten });
        log.info('printer selection forgotten', { transport: Transport.name, forgotten });
      } catch (error) {
        log.warn('could not forget the printer selection', { transport: Transport.name, message: error.message });
        results.push({ transport: Transport.name, forgotten: false, error: error.message });
      }
    }
    return results;
  }

  async function refresh() {
    if (state.status !== 'connected') return null;
    assertIdle();
    return discover();
  }

  function assertConnected() {
    if (!client || state.status !== 'connected') throw new PrinterError('Printer is not connected');
  }

  function assertIdle() {
    if (state.printing) throw new PrinterError('A print job is running; wait for it to finish');
    if (state.readingInfo) throw new PrinterError('A device info read is running; wait for it to finish');
  }

  async function print(raster, { copies, onProgress, onStart, signal, lengthMm } = {}) {
    assertConnected();
    assertIdle();

    const activeSession = session;
    const activeClient = client;
    // The lock is published before the first await: a concurrent print() or
    // discovery that starts in the same tick must see it.
    update({ printing: true });
    const controllerAbort = new AbortController();
    /** Set once printEnd is committed: cancel() can no longer change the outcome. */
    controllerAbort.committed = false;
    currentJob = controllerAbort;
    const jobSignal = signal ? AbortSignal.any([controllerAbort.signal, signal]) : controllerAbort.signal;
    // A printer error while this job owns the link has no reply to reject (the
    // raster phase has no outstanding request), so the job subscribes and
    // turns it into the abort reason: rows stop, CancelPrint goes out, and the
    // caller reports the real cause once.
    const onPrinterError = (error) => controllerAbort.abort(error);
    activeSession?.events.on('error', onPrinterError);
    let started = false;
    try {
      // A discovery already running on this session owns the request stream:
      // its probe frames must never land between the job's bitmap rows.
      if (discovery?.session === activeSession) {
        try {
          await discovery.promise;
        } catch {
          // The job re-reads the state it needs through its own gate.
        }
      }
      if (jobSignal.aborted) throw abortReason(jobSignal);
      const resolved = resolvePrintOptions({
        settings: printSettingsSnapshot(),
        capabilities: state.capabilities,
        copies: copies ?? 1,
      });
      log.info('print requested', resolved);
      await runPrintJob(activeClient, {
        raster,
        ...resolved,
        onProgress,
        // The UI learns that paper is really moving from the job itself: a
        // gate refusal never starts one, so it must not claim Printing either.
        onStart: () => {
          started = true;
          onStart?.();
        },
        onTerminalCommit: () => {
          controllerAbort.committed = true;
        },
        signal: jobSignal,
        // The gate runs inside the lock on the job's own fresh heartbeat: a
        // stale sensor or battery reading must never decide whether paper moves.
        gate: (sample) => {
          // "No answer" is not "all clear": when the printer has told us it has
          // sensors, a job without a fresh sample is refused.
          if (!sample && state.capabilities.sensors) {
            throw new PrinterError('The printer did not report its sensors; refusing to print');
          }
          const fresh = applyHeartbeatSample(state.capabilities, sample);
          if (fresh !== state.capabilities) update({ capabilities: fresh });
          const blocked = printBlockReason(fresh);
          if (blocked) throw new PrinterError(blocked);
        },
      });
      rememberCurrentRoll(lengthMm);
      events.emit('printed', resolved);
      return resolved;
    } finally {
      activeSession?.events.off?.('error', onPrinterError);
      // Only the job that still owns the lock may refresh and release it.
      const owner = currentJob === controllerAbort;
      currentJob = null;
      update({ progress: null });
      // The outcome is settled: from here on only the device refresh runs, and
      // a Cancel would be a silent no-op. Every terminal outcome (success,
      // failure, user cancel) publishes this before the refresh. `started`
      // tells the UI whether paper ever began moving, so a refused job keeps
      // its "Preparing…" state instead of claiming Finishing.
      if (owner) events.emit('finishing', { started });
      // Refresh INSIDE the job lock, for every outcome: its probe frames must
      // not land between the next job's bitmap rows, and `printing` must stay
      // true until the printer state is current again. runDiscovery() rather
      // than discover(): this call owns the stream and must not join (or
      // create) a cached pass that a later caller would share.
      if (owner && session === activeSession && state.status === 'connected') {
        try {
          await runDiscovery(activeSession, activeClient);
        } catch (error) {
          log.debug('post-print refresh failed', { message: error.message });
        }
      }
      if (owner) update({ printing: false });
    }
  }

  /** Ask the printer to feed / align one label (0x8E). */
  async function calibrate() {
    assertConnected();
    assertIdle();
    const data = await client.request('calibrate', { value: 0x01 });
    const accepted = data?.[0] === 0x01;
    log.info('calibrate', { accepted });
    events.emit('calibrated', accepted);
    return accepted;
  }

  /**
   * Read or write the printer's two sound switches (0x58).
   *
   * The reply's third byte is the only statement of the resulting state. A
   * short or unrecognised reply, and an unsupported/timeout probe, report
   * `null` — "the printer did not say" — never `false`. Treating absence as
   * "off" flipped the switch off after a successful write and claimed a state
   * the printer never reported.
   * @returns {Promise<boolean|null>}
   */
  async function soundSettings(item, value) {
    assertConnected();
    assertIdle();
    const data = await client.tryRequest('soundSettings', { action: value === undefined ? 0x02 : 0x01, item, value: value ?? 0x00 });
    if (data === null) return null;
    if (data[2] === 0x01) return true;
    if (data[2] === 0x00) return false;
    return null;
  }

  async function setAutoShutdown(value) {
    assertConnected();
    assertIdle();
    await client.request('setAutoShutdown', { value });
    // The capability model is the single read source for the UI, so a
    // successful write updates it instead of leaving a stale value behind.
    update({ capabilities: { ...state.capabilities, autoShutdown: value } });
    events.emit('settings-changed', { autoShutdown: value });
  }

  /** Built-in printer self-test page (0x5A). Prints paper. */
  async function testPage() {
    assertConnected();
    assertIdle();
    await client.request('testPage');
    log.info('self-test page requested');
  }

  /** Reset the printer's stored settings (0x28). Destructive. */
  async function resetPrinter() {
    assertConnected();
    assertIdle();
    await client.request('reset');
    log.warn('printer settings reset');
    // discover() mirrors the printer's stored density and tape type itself, so
    // the panel never renders the pre-reset reading.
    return discover();
  }

  /** Run a read-only diagnostic command and return its decoded reply. */
  async function diagnostic(name) {
    assertConnected();
    assertIdle();
    return client.query(name);
  }

  async function syncClock() {
    assertConnected();
    assertIdle();
    await client.request('setRtc', { date: new Date() });
    log.info('clock synced');
  }

  /**
   * Cancel the running job, if any.
   * @returns {Promise<boolean>} true when there was something to cancel; false
   *          while the job outcome is already settled and only its post-print
   *          refresh is running (nothing is left on the wire to stop).
   */
  async function cancel() {
    if (currentJob) {
      // The terminal frame is already committed (printEnd is on the wire or
      // awaiting its ack): nothing can change the outcome, and a cancel frame
      // would be a second terminal frame. Report that honestly.
      if (currentJob.committed) return false;
      // The print job owns the single cancelPrint terminal frame.
      currentJob.abort();
      return true;
    }
    // The job already finished and its post-print refresh is running: nothing
    // is left to cancel, and a cancel frame would interleave with the probes.
    if (state.printing) return false;
    if (state.status !== 'connected' || !client) return false;
    try {
      await client.send('cancelPrint');
    } catch (error) {
      log.debug('cancel frame failed', { message: error.message });
    }
    return true;
  }

  async function pushSetting(key, value) {
    if (state.status !== 'connected') return;
    assertIdle();
    if (key === 'print.density') {
      const density = Math.round(clampToRange(value, state.capabilities.densityRange, CONFIG.print.density.default));
      await client.request('setDensity', { value: density });
    } else if (key === 'print.labelType') {
      await client.request('setLabelType', { value: Number(value) });
    }
  }

  function rememberCurrentRoll(lengthMm) {
    const barcode = state.capabilities.roll?.barcode;
    if (!barcode) return null;
    return rememberRoll(barcode, { lengthMm, labelType: Number(getSetting('print.labelType')) });
  }

  return {
    events,
    get state() {
      return state;
    },
    get capabilities() {
      return state.capabilities;
    },
    get connected() {
      return state.status === 'connected';
    },
    get printing() {
      return state.printing;
    },
    connect,
    choosePrinter,
    forgetPrinter,
    disconnect,
    refresh,
    print,
    calibrate,
    cancel,
    testPage,
    resetPrinter,
    diagnostic,
    readInfoDiagnostics,
    soundSettings,
    setAutoShutdown,
    syncClock,
    pushSetting,
    rememberCurrentRoll,
  };
}
