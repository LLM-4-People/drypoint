/**
 * Print panel: everything about the job and the hardware: printer settings
 * discovered from the device, maintenance actions and diagnostics.
 *
 * The panel is built once per capability revision and synced in place
 * afterwards, so a Refresh or a battery change never destroys the focused
 * control. Values that change often (battery, roll, sensors) are registered
 * stat rows rather than part of the build signature.
 */

import { CONFIG } from '../core/config.js';
import { el } from '../core/dom.js';
import { createLogger } from '../core/log.js';
import { getSetting, settingsForSurface } from '../core/settings.js';
import { SOUND_ITEMS } from '../protocol/commands.js';
import {
  autoShutdownOptions,
  capabilityState,
  clampToRange,
  describeDeviceStatus,
  labelTypeName,
  supportGate,
  CAPABILITY_GROUP_LABELS,
} from '../device/capabilities.js';
import { actionButton, group, isTextEntry, numberField, select, statRow, toggle } from './controls.js';
import { toast } from './toast.js';
import { confirmDialog, openModal } from './modal.js';
import { buildSettingControl } from './setting-control.js';
import { toHex } from '../core/format.js';
import { supportLabel, taskName } from '../protocol/models.js';

const log = createLogger('ui.print');

/** This protocol family prints one bit per dot and has no colour channel. */
const OUTPUT_DESCRIPTION = '1-bit monochrome';

export function createPrintPanel({ container, device, controller, onOpenLog, onExport, notify = toast, confirm = confirmDialog }) {
  /**
   * Every failure in this panel goes through here: one log line at error level
   * and one toast. These paths used to toast with nothing in the diagnostics log
   * (or log without telling the operator), which made field reports impossible
   * to diagnose.
   */
  function reportError(action, error, message = null) {
    log.error(action, error ? { message: error.message ?? String(error) } : undefined);
    notify(message ?? error?.message ?? action, { tone: 'error' });
  }

  let built = false;
  let revision = '';
  /** Bumped by every build; an in-flight device read from an older build is stale. */
  let buildToken = 0;
  /** 'idle' before the first read, then 'reading', 'known' or 'failed'. */
  let soundState = 'idle';
  /** One in-flight "Read device info": the second click joins it, never opens a second modal. */
  let deviceInfoRead = null;
  const fields = [];
  /** Controls that only work against a live printer. */
  let deviceOnly = [];
  /** Controls whose activation writes to the printer, with their gate scope. */
  let mutatingControls = [];
  /** Actions that work offline but not while a job or a connection owns the link. */
  let pendingOnly = [];
  let jobControls = [];
  let soundControls = [];
  let connectButton = null;
  let refreshButton = null;
  let shutdown = null;
  let soundHint = null;

  function register(control, getValue) {
    fields.push({ control, getValue, node: control.node });
    return control.node;
  }

  /** Put the refusal reason on the control the operator actually presses. */
  function setControlTitle(control, title) {
    const node = control.element ?? control.node.querySelector?.('button, input, select') ?? control.node;
    node.title = title;
  }

  function batteryLabel() {
    const battery = device.state.capabilities.battery;
    if (!battery) return 'n/a';
    return `${battery.percent}%${Number.isFinite(battery.voltageMv) ? ` · ${(battery.voltageMv / 1000).toFixed(2)} V` : ''}`;
  }

  function rollLabel() {
    const roll = device.state.capabilities.roll;
    return roll ? `${roll.remaining ?? '?'} left · ${roll.barcode ?? 'no tag'}` : 'n/a';
  }

  function sensorsLabel() {
    const sensors = device.state.capabilities.sensors;
    if (!sensors) return 'n/a';
    return `${sensors.lidClosed ? 'lid closed' : 'LID OPEN'} · ${sensors.paperPresent ? 'paper ok' : 'NO PAPER'}`;
  }

  /** Three-state rendering of a capability the printer may never have reported. */
  function reportedLabel(value) {
    const state = capabilityState(value);
    if (state === 'reported-yes') return 'Supported';
    if (state === 'reported-no') return 'Not supported';
    return 'Not reported';
  }

  /** The printer's own value. Only rendered while it is known. */
  function shutdownValue(caps = device.state.capabilities) {
    return caps.autoShutdown;
  }

  /**
   * Everything that changes the panel's structure. Volatile readings are
   * deliberately absent: their stat rows update through sync(). The in-flight
   * job state is absent too, or starting a job would rebuild every control.
   */
  function capabilityRevision() {
    const caps = device.state.capabilities;
    return JSON.stringify([
      device.state.status,
      device.state.error,
      device.state.transportLabel,
      caps.model,
      caps.modelSupport,
      caps.task,
      caps.deviceType,
      caps.serial,
      caps.firmware,
      caps.hardware,
      caps.protocolVersion,
      caps.headWidthPx,
      caps.dpi,
      caps.densityRange,
      caps.labelTypes,
      caps.autoShutdownRange,
      caps.hasRtc,
      caps.hasVolume,
      caps.hasCutter,
      caps.discovered,
      // Known/unknown, not the value: a write must not rebuild the panel.
      caps.autoShutdown == null ? 'auto-off unknown' : 'auto-off known',
      caps.source,
    ]);
  }

  /** Identify the focused control so a rebuild can put focus back on it. */
  function focusedKey() {
    const active = document.activeElement;
    if (!active || !container.contains(active)) return null;
    return active.getAttribute('aria-label') || active.textContent.trim() || active.tagName;
  }

  function restoreFocus(key) {
    if (!key) return;
    const match = [...container.querySelectorAll('button, input, select, textarea')].find(
      (node) => (node.getAttribute('aria-label') || node.textContent.trim()) === key
    );
    match?.focus();
  }

  /** Rebuild the whole panel, one named builder per group. */
  function build() {
    const focusKey = focusedKey();
    const token = ++buildToken;
    container.textContent = '';
    fields.length = 0;
    deviceOnly = [];
    mutatingControls = [];
    pendingOnly = [];
    jobControls = [];
    soundControls = [];
    connectButton = null;
    refreshButton = null;
    shutdown = null;
    soundHint = null;
    soundState = 'idle';
    revision = capabilityRevision();
    built = true;

    const caps = device.state.capabilities;
    const connected = device.connected;

    container.append(
      buildPrinterGroup(caps, connected),
      buildJobGroup(caps),
      buildMaintenanceGroup(caps, connected),
      buildDeviceSettingsGroup(caps, connected),
      buildCommandsGroup(),
      buildDiagnosticsGroup()
    );

    applyValues();
    if (connected && !device.state.printing) void loadDeviceSettings(token);
    restoreFocus(focusKey);
  }

  function buildPrinterGroup(caps, connected) {
    const assumed = Object.entries(caps.source ?? {})
      .filter(([, source]) => source === 'default')
      .map(([groupName]) => CAPABILITY_GROUP_LABELS[groupName] ?? groupName);

    const deviceRows = el(
      'div',
      {},
      register(statRow('Status'), () => describeDeviceStatus(device.state).panelLabel),
      // A failed connect leaves the reason in state.error; without this row the
      // panel says "Connection error" and never what happened.
      device.state.error ? register(statRow('Last error'), () => device.state.error ?? 'n/a') : null,
      register(statRow('Transport'), () => device.state.transportLabel ?? 'n/a'),
      register(statRow('Model'), () => {
        const live = device.state.capabilities;
        const id = live.deviceType ? ` · 0x${live.deviceType.toString(16).padStart(4, '0').toUpperCase()}` : '';
        // An unrecognised model is not named "Unknown: unknown": that reads
        // like a model and repeats the support state. Before discovery the
        // row stays empty instead of claiming an unknown printer.
        if (live.modelSupport === 'unknown') return `Unknown model${id}`;
        if (!live.model) return 'n/a';
        // The support state is part of the truth: a resolved name alone would
        // suggest every named model can print.
        const support = live.modelSupport ? ` (${supportLabel(live.modelSupport)})` : '';
        return `${live.model}${support}${id}`;
      }),
      register(statRow('Serial'), () => device.state.capabilities.serial ?? 'n/a'),
      register(statRow('Firmware'), () => {
        const live = device.state.capabilities;
        return live.firmware ? `${live.firmware} (hw ${live.hardware ?? '?'})` : 'n/a';
      }),
      register(statRow('Protocol'), () => {
        const live = device.state.capabilities;
        // Only a model this app may drive has a print task. An unsupported or
        // unknown model must not display a capability it does not have.
        if (live.modelSupport !== 'confirmed' && live.modelSupport !== 'experimental') {
          return 'Print task not available for this model';
        }
        // The job is the D110M V4 sequence by behaviour; a build number is
        // context, never a task name of its own.
        const task = taskName(live.task);
        if (task) return `${task} · build ${live.protocolVersion ?? '?'}`;
        return live.protocolVersion ? `build ${live.protocolVersion}` : 'n/a';
      }),
      register(statRow('Head'), () => {
        const live = device.state.capabilities;
        return `${live.headWidthPx} px · ${live.dpi ?? CONFIG.geometry.dpi} dpi${live.source?.geometry === 'reported' ? '' : ' (assumed)'}`;
      }),
      // The printer has one output: black dots. Colour and gray are protocol
      // features, not rows the operator can act on; their raw TLVs stay in the
      // capability diagnostic.
      statRow('Output', OUTPUT_DESCRIPTION).node,
      register(statRow('Battery'), batteryLabel),
      register(statRow('Roll'), rollLabel),
      register(statRow('Sensors'), sensorsLabel),
      register(statRow('Cutter'), () => reportedLabel(device.state.capabilities.hasCutter)),
      caps.discovered && assumed.length ? register(statRow('Assumed'), () => assumed.join(', ')) : null
    );

    const status = device.state.status;
    connectButton = actionButton(status === 'connected' ? 'Disconnect' : status === 'connecting' ? 'Connecting…' : 'Connect printer', {
      tone: status === 'connected' || status === 'connecting' ? '' : 'primary',
      onClick: async () => {
        try {
          if (device.connected) await device.disconnect();
          else await device.connect();
        } catch (error) {
          // Cancelling the browser's port picker is a normal outcome.
          if (error?.cancelled) {
            log.debug('printer selection cancelled');
            return;
          }
          reportError('connection action failed', error);
        }
      },
    });

    const choose = actionButton('Choose printer', {
      onClick: async () => {
        try {
          await device.choosePrinter();
          notify('Printer selected', { tone: 'ok' });
        } catch (error) {
          if (error?.cancelled) {
            log.debug('printer selection cancelled');
            return;
          }
          reportError('choosing a printer failed', error);
        }
      },
    });

    const forget = actionButton('Forget printer', {
      onClick: async () => {
        const confirmed = await confirm(
          'Forget the saved printer?',
          'The app will ask which printer to use next time. A browser serial-port permission is stored by the browser itself and can only be removed in the browser’s site settings.',
          { confirmLabel: 'Forget' }
        );
        if (!confirmed) return;
        try {
          const results = await device.forgetPrinter();
          if (results.some((result) => result.forgotten)) {
            notify('Saved printer forgotten', { tone: 'ok' });
          } else {
            notify('No saved printer was removed. A browser port permission must be cleared in the browser’s site settings.');
          }
        } catch (error) {
          reportError('forgetting the printer failed', error);
        }
      },
    });
    pendingOnly.push(choose, forget);

    refreshButton = actionButton('Refresh', {
      onClick: async () => {
        if (!device.connected) {
          reportError('refresh refused while offline', null, 'Connect the printer before refreshing');
          return;
        }
        try {
          await device.refresh();
          notify('Printer refreshed', { tone: 'ok' });
          // A sound read that failed or came back without a state is retried on
          // an explicit refresh; the panel never silently claims the old
          // switch positions.
          if (soundState === 'failed' || soundState === 'unread') void loadDeviceSettings(buildToken);
        } catch (error) {
          reportError('refresh failed', error);
        }
      },
    });
    refreshButton.node.title = connected ? 'Read the printer state again' : 'Connect the printer first';

    return group(
      'Printer',
      [deviceRows, el('div', { class: 'btn-row' }, connectButton.node, choose.node, forget.node, refreshButton.node)]
    );
  }

  /**
   * The density range this app offers for this printer.
   *
   * The schema declares what the app can render and the printer reports what it
   * accepts; a write may only use the intersection of the two. An empty
   * intersection (a firmware whose whole range sits outside the schema) keeps
   * the schema range (the panel cannot render an impossible slider) and the
   * job group says so instead of silently offering unprintable values.
   */
  function densityBounds(definition, caps) {
    const schema = { min: definition.min, max: definition.max };
    const reported = caps.densityRange;
    if (!reported || !Number.isFinite(reported.min) || !Number.isFinite(reported.max)) {
      return { ...schema, unsupported: false };
    }
    const min = Math.max(schema.min, reported.min);
    const max = Math.min(schema.max, reported.max);
    if (min > max) return { ...schema, unsupported: true, reported };
    return { min, max, unsupported: false };
  }

  /**
   * A job setting's control, built from the schema. `overrides` adapts the
   * declared range/options to what this printer reported; the schema keeps the
   * label, order and option text.
   */
  function jobOverrides(definition, caps) {
    if (definition.key === 'print.density') {
      const bounds = densityBounds(definition, caps);
      return {
        min: bounds.min,
        max: bounds.max,
        value: clampToRange(getSetting(definition.key), bounds, CONFIG.print.density.default),
      };
    }
    if (definition.key === 'print.labelType') {
      const schemaOptions = definition.options ?? [];
      const supported = caps.labelTypes?.length ? caps.labelTypes.map(Number) : null;
      const filtered = supported ? schemaOptions.filter(([id]) => supported.includes(Number(id))) : schemaOptions;
      const options = filtered.length ? filtered : schemaOptions;
      const stored = String(getSetting(definition.key));
      return { options, value: options.some(([id]) => id === stored) ? stored : options[0]?.[0] };
    }
    return {};
  }

  /** The control's own value: the stored setting adapted to the live printer. */
  function jobValue(definition, caps) {
    if (definition.key === 'print.density') {
      // The same bounds owner the control was built from: a value outside the
      // intersection would make sync() write a value the slider cannot show.
      return clampToRange(getSetting(definition.key), densityBounds(definition, caps), CONFIG.print.density.default);
    }
    if (definition.key === 'print.labelType') {
      const options = jobOverrides(definition, caps).options ?? [];
      const stored = String(getSetting(definition.key));
      return options.some(([id]) => id === stored) ? stored : options[0]?.[0];
    }
    return getSetting(definition.key);
  }

  function buildJobGroup(caps) {
    const settings = settingsForSurface('print').filter((definition) => definition.group === 'Printing');
    const controls = settings.map((definition) => {
      const control = buildSettingControl(definition, {
        overrides: jobOverrides(definition, caps),
        onChange: (value) => {
          // Only a value the printer stores is pushed now; the rest travels in
          // the next job header.
          if (!definition.live || !device.connected) return;
          // The manager's refusal is the specific reason (unsupported model,
          // guessed geometry, busy link); never replace it with a generic
          // "the next print retries it" claim that the gate makes false.
          device.pushSetting(definition.key, value).catch((error) => reportError(`${definition.key} push failed`, error));
        },
      });
      register(control, () => jobValue(definition, caps));
      jobControls.push({ definition, control });
      return control.node;
    });

    const copies = numberField({
      label: 'Copies',
      value: controller.document.copies,
      min: CONFIG.print.copies.min,
      max: CONFIG.print.copies.max,
      onChange: (value) => controller.patchDocument({ copies: value }),
    });
    register(copies, () => controller.document.copies);
    controls.push(copies.node);

    if (!device.connected) {
      controls.push(
        el('div', { class: 'hint' }, 'Connect the printer to change density and tape type; those changes are disabled while offline.')
      );
    }
    // An empty intersection cannot be shown honestly as an editable value: the
    // slider can only render the schema range, while the job sends the
    // printer's range. Disable the control and state the wire value, so what
    // the operator sees and what the next print sends agree.
    const densityDefinition = settings.find((definition) => definition.key === 'print.density');
    const bounds = densityDefinition ? densityBounds(densityDefinition, caps) : null;
    if (bounds?.unsupported) {
      const wireValue = Math.round(clampToRange(getSetting('print.density'), bounds.reported, CONFIG.print.density.default));
      controls.push(
        el(
          'div',
          { class: 'hint' },
          `The printer accepts density ${bounds.reported.min}-${bounds.reported.max}, outside this app's ${densityDefinition.min}-${densityDefinition.max}; the density control is disabled and the next print sends ${wireValue}.`
        )
      );
    }
    return group('Print job', controls);
  }

  function buildMaintenanceGroup(caps, connected) {
    const feed = actionButton('Feed / align paper', {
      onClick: async () => {
        const confirmed = await confirm('Feed one label?', 'The printer advances one label to align the roll. This uses paper.', {
          confirmLabel: 'Feed',
          tone: 'primary',
        });
        if (!confirmed) return;
        try {
          const accepted = await device.calibrate();
          if (!accepted) {
            reportError('feed command rejected', null, 'Printer rejected the feed command');
            return;
          }
          notify('Paper fed', { tone: 'ok' });
        } catch (error) {
          reportError('feed command failed', error);
        }
      },
    });

    const experimental = caps.modelSupport === 'experimental';
    const selfTest = actionButton('Self-test page', {
      onClick: async () => {
        // The self-test prints paper too, so an experimental model gets the
        // same explicit warning as a normal print, not only the paper prompt.
        const experimentalText = experimental
          ? `${caps.model ?? 'This printer'}. ${CONFIG.device.printGate.experimental}`
          : null;
        const confirmed = await confirm(
          experimental ? 'Print the self-test page on an experimental model?' : 'Print the self-test page?',
          [experimentalText, 'The printer prints its built-in test label. This uses paper.'].filter(Boolean).join('\n\n'),
          { confirmLabel: 'Print test', tone: 'primary' }
        );
        if (!confirmed) return;
        try {
          await device.testPage();
          notify('Self-test page sent to the printer', { tone: 'ok' });
        } catch (error) {
          reportError('self-test page failed', error);
        }
      },
    });

    // A printer that reports no RTC gets a plain "not supported" row instead
    // of a button that can only fail. The capability survives a disconnect, so
    // the row does not turn back into a button while offline.
    const clockState = capabilityState(caps.hasRtc);
    const clock = clockState === 'reported-no'
      ? statRow('Sync clock', 'Not supported by this printer')
      : (() => {
          const button = actionButton('Sync clock', {
            onClick: async () => {
              try {
                await device.syncClock();
                notify('Clock synced', { tone: 'ok' });
              } catch (error) {
                reportError('clock sync failed', error);
              }
            },
          });
          button.node.title = !connected
            ? 'Connect the printer first'
            : clockState === 'not-reported'
              ? 'The printer did not report clock support; the command may be rejected'
              : '';
          deviceOnly.push(button);
          mutatingControls.push({ control: button, requiresPaper: false });
          return button;
        })();

    deviceOnly.push(feed, selfTest);
    mutatingControls.push({ control: feed, requiresPaper: true }, { control: selfTest, requiresPaper: true });
    return group('Maintenance', [feed.node, selfTest.node, clock.node]);
  }

  function buildDeviceSettingsGroup(caps, connected) {
    const settingsControls = [];
    if (caps.autoShutdown != null) {
      shutdown = select({
        label: 'Auto power-off',
        options: autoShutdownOptions(caps),
        value: String(shutdownValue(caps)),
        onChange: async (value) => {
          const previous = shutdownValue();
          try {
            await device.setAutoShutdown(Number(value));
            notify('Auto power-off updated', { tone: 'ok' });
          } catch (error) {
            // The printer kept its old value; never leave the control claiming
            // the write succeeded.
            shutdown?.set(String(previous));
            reportError('auto power-off update failed', error);
          }
        },
      });
      register(shutdown, () => String(shutdownValue()));
      mutatingControls.push({ control: shutdown, requiresPaper: false });
      settingsControls.push(shutdown.node);
    } else {
      settingsControls.push(statRow('Auto power-off', 'Not reported').node);
    }

    const volumeState = capabilityState(caps.hasVolume);
    if (volumeState === 'reported-no') {
      settingsControls.push(el('div', { class: 'hint' }, 'Sound settings are not supported by this printer.'));
    } else {
      const soundBt = soundSwitch(SOUND_ITEMS.bluetooth, 'Bluetooth sound');
      const soundPower = soundSwitch(SOUND_ITEMS.power, 'Power sound');
      soundControls = [soundBt, soundPower];
      mutatingControls.push(
        { control: soundBt.control, requiresPaper: false },
        { control: soundPower.control, requiresPaper: false }
      );
      soundHint = el('div', { class: 'hint', id: 'soundHint' }, '');
      soundHint.hidden = true;
      settingsControls.push(soundBt.control.node, soundPower.control.node, soundHint);
      if (!connected) {
        soundHint.textContent = 'Connect the printer to read the sound state.';
        soundHint.hidden = false;
      }
    }
    return group('Device settings', settingsControls);
  }

  /**
   * A sound switch never claims a state before the printer reported one. It
   * stays disabled and visibly unknown until the read resolves, and a write
   * whose reply carries no state is reverted instead of being reported as a
   * success.
   *
   * `apply` is the one setter: it remembers the last confirmed value so a
   * failed or unconfirmed write can restore exactly what the printer last said.
   */
  function soundSwitch(item, label) {
    let confirmed = null;
    const control = toggle({
      label,
      // Never read yet: the switch must not announce "off" for a value the
      // printer has not reported. The hint explains the unknown state.
      checked: null,
      hintId: 'soundHint',
      onChange: async (value) => {
        const previous = confirmed;
        try {
          const on = await device.soundSettings(item, value ? 0x01 : 0x00);
          if (on === null) {
            // A completed exchange without a state is not a link failure: the
            // printer simply did not confirm. Show the last confirmed value
            // and say so, through the panel's ordinary message path.
            apply(previous);
            setSoundHint('The printer did not confirm the sound setting');
            notify('The printer did not confirm the sound setting', { tone: 'error' });
            return;
          }
          // The reply is the authority, not the tap.
          apply(on);
          setSoundHint('');
        } catch (error) {
          apply(previous);
          reportError(`${label.toLowerCase()} update failed`, error);
        }
      },
    });
    const apply = (next) => {
      confirmed = next === true || next === false ? next : null;
      control.set(confirmed);
    };
    control.node.dataset.state = 'unknown';
    control.setDisabled(true);
    return { control, apply, item, state: 'unknown' };
  }

  function setSoundHint(text) {
    if (!soundHint) return;
    soundHint.textContent = text;
    soundHint.hidden = !text;
  }

  /** Read both sound switches; a failure leaves the group visibly unknown. */
  async function loadDeviceSettings(token = buildToken) {
    // Another read owns the link: soundSettings would be refused by the
    // manager, so wait for the next state event rather than manufacture an
    // error from a read that was never allowed to run.
    if (!device.connected || device.state.printing || device.state.readingInfo || device.state.maintaining || soundControls.length !== 2) return;
    soundState = 'reading';
    setSoundHint('Reading…');
    for (const entry of soundControls) {
      entry.state = 'reading';
      entry.control.setDisabled(true);
    }
    // The read owns the link: the same set the manager's assertIdle refuses
    // must wait for it, or Disconnect/Refresh would settle the read under the
    // panel and report a link failure the operator caused on purpose.
    applyValues();

    const results = await Promise.allSettled(soundControls.map((entry) => device.soundSettings(entry.item)));
    if (token !== buildToken) return;

    const failure = results.find((result) => result.status === 'rejected')?.reason ?? null;
    let known = 0;
    results.forEach((result, index) => {
      const entry = soundControls[index];
      if (result.status === 'rejected' || result.value === null) {
        // A rejected request is a link/protocol failure; a null answer means
        // the printer completed the exchange but did not report this switch
        // (unsupported or timed out). Neither may be rendered as "off".
        entry.state = result.status === 'rejected' ? 'failed' : 'unread';
        entry.control.node.dataset.state = 'unknown';
        entry.apply(null);
        entry.control.setDisabled(true);
        return;
      }
      entry.state = 'known';
      entry.control.node.dataset.state = 'known';
      entry.apply(result.value);
      entry.control.setDisabled(false);
      known += 1;
    });

    if (failure && !device.connected) {
      // The operator disconnected while the read was in flight. That is a
      // deliberate outcome, not a printer failure: log it and let the offline
      // panel own the hint. No error toast on top of the disconnect.
      soundState = 'idle';
      setSoundHint('Connect the printer to read the sound state.');
      log.debug('sound state read stopped: printer disconnected', { message: failure.message });
      applyValues();
      return;
    }
    if (failure) {
      soundState = 'failed';
      // Say only what the read knows: a partial failure leaves the reported
      // switch usable and must not claim its state is unknown too.
      const text = known ? 'Some sound settings could not be read' : 'Sound state unknown';
      setSoundHint(text);
      reportError('sound state read failed', failure, text);
      applyValues();
      return;
    }
    if (known < soundControls.length) {
      // The read completed; the printer just has nothing to say. That is not
      // an error, so it is a debug line and a visible hint, never an error
      // toast, and an explicit Refresh retries it.
      soundState = 'unread';
      setSoundHint('Sound state not reported');
      log.debug('sound switch state not reported', { connected: device.connected });
      applyValues();
      return;
    }
    soundState = 'known';
    setSoundHint('');
    applyValues();
  }

  function buildCommandsGroup() {
    const paperInfo = actionButton('Read paper info', {
      onClick: async () => {
        try {
          const info = await device.diagnostic('paperInfo');
          showDecoded('Paper info (0x59 → 0x69)', info);
        } catch (error) {
          reportError('paper info read failed', error);
        }
      },
    });

    const history = actionButton('Read history', {
      onClick: async () => {
        try {
          const info = await device.diagnostic('printHistory');
          showDecoded('Print history (0x52 → 0x62)', info);
        } catch (error) {
          reportError('print history read failed', error);
        }
      },
    });

    const capabilities = actionButton('Read capabilities', {
      onClick: async () => {
        try {
          showCapabilities(await device.diagnostic('capabilities'));
        } catch (error) {
          reportError('capability read failed', error);
        }
      },
    });

    const deviceInfo = actionButton('Read device info', {
      onClick: async () => {
        // The manager joins a second read to the first promise; the panel must
        // join it too, or both clicks open an identical modal when it settles.
        if (deviceInfoRead) return deviceInfoRead;
        deviceInfoRead = (async () => {
          try {
            showDeviceInfo(await device.readInfoDiagnostics());
          } catch (error) {
            // A read that fails because the link went away is the expected
            // outcome of unplugging or disconnecting while the panel is open:
            // log it, but do not report an error the operator cannot act on.
            if (!device.connected) {
              log.debug('device info read stopped: printer disconnected', { message: error.message });
              return;
            }
            reportError('device info read failed', error);
          } finally {
            deviceInfoRead = null;
          }
        })();
        return deviceInfoRead;
      },
    });

    const reset = actionButton('Reset settings', {
      tone: 'danger',
      onClick: async () => {
        const confirmed = await confirm(
          'Reset printer settings?',
          'The printer’s stored density, tape type and auto power-off return to factory defaults. This cannot be undone on the printer. The app re-reads the printer afterwards; density and tape type are also re-sent with every print.',
          { confirmLabel: 'Reset' }
        );
        if (!confirmed) return;
        try {
          await device.resetPrinter();
          notify('Printer settings reset', { tone: 'ok' });
        } catch (error) {
          reportError('printer reset failed', error);
        }
      },
    });

    deviceOnly.push(paperInfo, history, capabilities, deviceInfo, reset);
    mutatingControls.push({ control: reset, requiresPaper: false });
    return group('Device commands', [paperInfo.node, history.node, capabilities.node, deviceInfo.node, reset.node]);
  }

  function buildDiagnosticsGroup() {
    // The level control lives here, next to the viewer and the export action;
    // the settings sheet no longer renders it. It writes through the settings
    // store, and the single subscription in main.js applies the level.
    const diagnosticsControls = settingsForSurface('print')
      .filter((definition) => definition.group === 'Diagnostics')
      .map((definition) => buildSettingControl(definition).node);
    return group('Diagnostics', [
      ...diagnosticsControls,
      el('div', { class: 'hint' }, 'The viewer and the exported report include entries at this level and above.'),
      el(
        'div',
        { class: 'btn-row' },
        actionButton('Open log', { small: true, onClick: onOpenLog }).node,
        actionButton('Export report', { small: true, onClick: onExport }).node
      ),
    ]);
  }

  /** Sync values and enablement in place; never rebuilds by itself. */
  function applyValues() {
    const connected = device.connected;
    // A print job, a device-info read and this panel's own sound read all own
    // the single link, so every control that sends a command waits for the
    // same idle state, including Disconnect, which would tear the read down
    // mid-exchange. The primary Print button is main's; it never gates on the
    // panel's read state.
    const busy = Boolean(device.state.printing) || Boolean(device.state.readingInfo) || Boolean(device.state.maintaining) || soundState === 'reading';
    const status = device.state.status;
    // Configuration writes need a supported model with real geometry; a sensor
    // reading only restricts commands that move or print paper.
    const configGate = supportGate(device.state.capabilities, { requiresPaper: false });
    const configBlocked = !configGate.allowed;
    for (const field of fields) {
      // Only a caret-owning control keeps its own value. A focused switch or
      // segmented control must still follow the model after an undo.
      if (isTextEntry(document.activeElement) && field.node.contains(document.activeElement)) continue;
      const value = field.getValue();
      if (field.control === shutdown && !shutdown.hasOption(value)) {
        // The printer reported an auto-off level after the panel was built;
        // a <select> silently selects nothing for an unknown value. Rebuild
        // the list from its one owner, then select the reported value.
        shutdown.setOptions(autoShutdownOptions(device.state.capabilities), value);
        continue;
      }
      field.control.set?.(value);
    }
    for (const { definition, control } of jobControls) {
      // An empty printer/schema intersection has no honest editable value: the
      // hint names the value the job will send, so the control stays disabled.
      const unsupported = definition.key === 'print.density' && densityBounds(definition, device.state.capabilities).unsupported;
      control.setDisabled?.(unsupported || (Boolean(definition.live) && (!connected || busy || configBlocked)));
      if (definition.live) setControlTitle(control, configBlocked ? configGate.reason : '');
    }
    shutdown?.setDisabled?.(!connected || busy || configBlocked);
    if (shutdown) setControlTitle(shutdown, configBlocked ? configGate.reason : '');
    refreshButton?.setDisabled?.(!connected || busy);
    connectButton?.setDisabled?.(status === 'connecting' || busy);
    for (const control of pendingOnly) control.setDisabled?.(status === 'connecting' || busy);
    // Every live control (clock, feed, self-test, diagnostics, reset) is
    // registered in deviceOnly, which owns the connected-only gate.
    for (const control of deviceOnly) control.setDisabled?.(!connected || busy);
    // Every mutating control additionally follows the one support gate before
    // the operator can reach the manager. Reads stay enabled.
    for (const { control, requiresPaper } of mutatingControls) {
      const gate = supportGate(device.state.capabilities, { requiresPaper });
      control.setDisabled?.(!connected || busy || !gate.allowed);
      setControlTitle(control, gate.allowed ? '' : gate.reason);
    }
    // A sound switch is only editable when the printer confirmed that one
    // switch; another switch's read says nothing about it.
    for (const entry of soundControls) {
      entry.control.setDisabled?.(!connected || busy || configBlocked || entry.state !== 'known');
      setControlTitle(entry.control, configBlocked ? configGate.reason : '');
    }
  }

  function render() {
    if (!built) return build();
    if (capabilityRevision() !== revision) return build();
    applyValues();
    // A build made during a print job or an info read skips the sound read;
    // once the link is idle again, run it instead of leaving the switches
    // unknown forever. loadDeviceSettings re-checks the lock itself.
    if (device.connected && !device.state.printing && soundState === 'idle' && soundControls.length === 2) {
      void loadDeviceSettings(buildToken);
    }
  }

  /** Show a decoder result: named fields when known, raw bytes always. */
  function showDecoded(title, decoded) {
    const raw = Array.isArray(decoded?.raw) ? decoded.raw : decoded instanceof Uint8Array ? [...decoded] : [];
    const lines = [];
    if (Number.isFinite(decoded?.length)) lines.push(`${decoded.length} bytes`);
    for (const [name, value] of Object.entries(decoded?.fields ?? {})) lines.push(`${name}: ${value}`);
    if (decoded?.unverified) lines.push('Layout not verified; raw bytes shown.');
    const body = el(
      'div',
      {},
      ...lines.map((line) => el('div', { class: 'stat-row' }, el('span', { class: 'label' }, line))),
      el('div', { class: 'log-view', style: { marginTop: '10px' } }, toHex(raw))
    );
    openModal({ title, body, actions: [{ label: 'Close', tone: 'primary' }] });
  }

  /**
   * The capability TLV as the printer sent it. Colour and gray are protocol
   * features with no control in the panel, so this is where their raw values
   * stay inspectable instead of being dropped.
   */
  function showCapabilities(decoded) {
    const lines = [];
    const range = (label, value) => {
      if (value) lines.push(`${label}: ${value.min}-${value.max}`);
    };
    range('Density range', decoded?.densityRange);
    range('Speed range', decoded?.speedRange);
    range('Battery range', decoded?.batteryRange);
    range('Auto power-off range', decoded?.autoShutdownRange);
    if (decoded?.labelTypes?.length) lines.push(`Tape types: ${decoded.labelTypes.map((id) => labelTypeName(id)).join(', ')}`);
    if (decoded?.dpi != null) lines.push(`Head dpi: ${decoded.dpi}`);
    if (decoded?.headWidthPx != null) lines.push(`Head width: ${decoded.headWidthPx} px`);
    if (decoded?.maxPrintHeightPx != null) lines.push(`Max print height: ${decoded.maxPrintHeightPx} px`);
    lines.push(`Colour reported: ${reportedLabel(decoded?.supportsColor)}`);
    lines.push(`Gray reported: ${reportedLabel(decoded?.supportsGray)}`);
    lines.push(`Cutter reported: ${reportedLabel(decoded?.hasCutter)}`);
    lines.push(`Clock reported: ${reportedLabel(decoded?.hasRtc)}`);
    lines.push(`Sound reported: ${reportedLabel(decoded?.hasVolume)}`);
    lines.push(`Roll tag read reported: ${reportedLabel(decoded?.rfidRead)}`);

    const raw = Object.entries(decoded?.raw ?? {}).map(([name, bytes]) => `${name}: ${toHex(bytes)}`);
    const body = el(
      'div',
      {},
      ...lines.map((line) => el('div', { class: 'stat-row' }, el('span', { class: 'label' }, line))),
      el('div', { class: 'hint', style: { marginTop: '12px' } }, 'Raw TLV values'),
      el('div', { class: 'log-view' }, ...raw.map((line) => el('div', {}, line)))
    );
    openModal({ title: 'Capabilities (0xAF → 0xBF)', body, wide: true, actions: [{ label: 'Close', tone: 'primary' }] });
  }

  /** Show the GetInfo keys discovery does not consume automatically. */
  function showDeviceInfo(entries) {
    const rows = [];
    for (const { name, decoded } of entries) {
      rows.push(el('div', { class: 'stat-row' }, el('span', { class: 'label' }, name)));
      const values = decoded && typeof decoded === 'object' ? Object.entries(decoded) : [];
      if (!values.length) {
        rows.push(el('div', { class: 'hint' }, 'Not reported'));
        continue;
      }
      for (const [field, value] of values) {
        rows.push(
          el('div', { class: 'stat-row' }, el('span', { class: 'label' }, `${field}: ${typeof value === 'object' ? JSON.stringify(value) : value}`))
        );
      }
    }
    openModal({ title: 'Device info (0x40 GetInfo)', body: el('div', {}, ...rows), wide: true, actions: [{ label: 'Close', tone: 'primary' }] });
  }

  return { render, sync: render };
}
