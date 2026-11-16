/**
 * Capability model: merges what the printer reports (capability TLV, heartbeat
 * frames, GetInfo keys, roll tag) into one object the UI reads.
 */

import { CONFIG } from '../core/config.js';
import { maxLengthFor, pitchFor, usableDpi } from '../core/geometry.js';
import { modelFor } from '../protocol/models.js';


const reported = (value) => value !== null && value !== undefined;

/** Human names for the `source` groups, so the UI never prints internal keys. */
export const CAPABILITY_GROUP_LABELS = Object.freeze({
  model: 'Model',
  geometry: 'Head geometry',
  density: 'Density',
  labelType: 'Tape type',
  battery: 'Battery',
  sensors: 'Sensors',
  rfid: 'Roll tag',
  rtc: 'Clock',
  volume: 'Sound',
  cutter: 'Cutter',
  autoShutdown: 'Auto power-off',
});

/**
 * A reported boolean is three-valued: supported, reported-unsupported, or never
 * reported. The UI must render all three differently.
 * @returns {'reported-yes'|'reported-no'|'not-reported'}
 */
export function capabilityState(value) {
  if (value === true) return 'reported-yes';
  if (value === false) return 'reported-no';
  return 'not-reported';
}

/**
 * Every connection state the device manager publishes. The header pill and the
 * Print panel read one table, so a status can never render as "Offline" in one
 * place and as something else in the other.
 */
export const CONNECTION_STATUSES = Object.freeze(['idle', 'connecting', 'connected', 'error']);

const OFFLINE_TEXT = Object.freeze({
  idle: { dot: 'offline', label: 'Connect printer', shortLabel: 'Connect', title: 'Connect printer', panelLabel: 'Offline' },
  connecting: { dot: 'connecting', label: 'Connecting…', shortLabel: 'Connecting…', title: 'Connecting…', panelLabel: 'Connecting…' },
  error: { dot: 'error', label: 'Connect printer', shortLabel: 'Connect', title: 'Connect printer', panelLabel: 'Connection error' },
});

/**
 * One description of a device state, shared by the header pill and the panel.
 * @param {{status?:string, capabilities?:object, transportLabel?:string|null}} state
 */
export function describeDeviceStatus(state = {}) {
  const status = CONNECTION_STATUSES.includes(state.status) ? state.status : 'idle';
  if (status === 'connected') {
    // A printer that never named its model is still a printer: naming a made-up
    // model would be a fabricated fact in the header and the panel. A reported
    // id outside the table is not a model name either: say "Unknown model".
    const reportedModel = state.capabilities?.model;
    const model = reportedModel === 'Unknown' ? 'Unknown model' : reportedModel ?? 'Printer';
    const serial = state.capabilities?.serial;
    const label = `${model}${serial ? ` · ${serial}` : ''}`;
    // The narrow header pill shows only the model, never a truncated
    // "Connect p…"; the full label and the accessible name keep the serial.
    const shortLabel = reportedModel === 'Unknown' ? 'Unknown' : reportedModel ?? 'Printer';
    const transport = state.transportLabel ? ` · ${state.transportLabel}` : '';
    return {
      status,
      dot: 'online',
      label,
      shortLabel,
      title: `Open printer controls${transport}`,
      // The accessible name contains the visible text (WCAG 2.5.3).
      ariaLabel: `${label} — open printer controls`,
      panelLabel: 'Connected',
    };
  }
  const text = OFFLINE_TEXT[status];
  return { status, ...text, ariaLabel: text.label };
}

/** Sensors are usable only when the printer actually reported both flags. */
function sensorsFrom(advanced) {
  if (typeof advanced?.lidClosed !== 'boolean' || typeof advanced?.paperPresent !== 'boolean') return null;
  return { lidClosed: advanced.lidClosed, paperPresent: advanced.paperPresent, rfidOk: advanced.rfidOk ?? null };
}

function batteryFrom(advanced, info) {
  if (advanced && Number.isFinite(advanced.batteryPercent)) {
    return {
      percent: advanced.batteryPercent,
      level: advanced.batteryLevel,
      voltageMv: advanced.voltageMv,
      temperatureRaw: advanced.temperatureRaw,
    };
  }
  return reported(info?.batteryPercent) ? { percent: info.batteryPercent, level: info.batteryLevel } : null;
}

export function emptyCapabilities() {
  return {
    model: null,
    modelSupport: null,
    task: null,
    deviceType: null,
    serial: null,
    firmware: null,
    hardware: null,
    protocolVersion: null,
    headWidthPx: CONFIG.geometry.widthPx,
    dpi: null,
    maxLengthMm: CONFIG.geometry.maxLengthMm,
    density: null,
    densityRange: { min: CONFIG.print.density.min, max: CONFIG.print.density.max },
    labelType: null,
    labelTypes: Object.keys(CONFIG.print.labelTypes).map(Number),
    rfid: { read: null, write: null },
    battery: null,
    roll: null,
    sensors: null,
    autoShutdown: null,
    autoShutdownRange: null,
    // null = the printer never reported the feature; false = it reported "no".
    hasRtc: null,
    hasVolume: null,
    hasCutter: null,
    discovered: false,
    /** 'reported' when the printer answered, 'default' when the value is a guess. */
    source: {
      model: 'default',
      // The gate's two geometry facts are marked separately so a refusal can
      // name the one the printer withheld. `geometry` is the combined claim.
      headWidth: 'default',
      dpi: 'default',
      geometry: 'default',
      density: 'default',
      labelType: 'default',
      battery: 'default',
      sensors: 'default',
      rfid: 'default',
      rtc: 'default',
      volume: 'default',
      cutter: 'default',
      autoShutdown: 'default',
    },
  };
}

/**
 * @param {object} input
 * @param {ReturnType<import('../protocol/replies.js').decodeHeartbeatInfo>} [input.heartbeat]
 * @param {ReturnType<import('../protocol/replies.js').decodeHeartbeatAdvanced>} [input.advanced]
 * @param {ReturnType<import('../protocol/replies.js').decodeCapabilities>} [input.capabilities]
 * @param {ReturnType<import('../protocol/replies.js').decodeStatusData>} [input.statusData]
 * @param {Record<string, unknown>} [input.info] decoded GetInfo values
 * @param {ReturnType<import('../protocol/replies.js').decodeRfid>} [input.roll]
 * @param {object} [input.previous] the same session's last published model; a
 *        group this discovery did not report falls through to it instead of
 *        reverting to a default
 */
export function mergeCapabilities({ heartbeat, advanced, capabilities, statusData, info = {}, roll, previous = null } = {}) {
  const base = emptyCapabilities();
  // One fall-through rule per group: a probe that went unanswered on this pass
  // must not erase a fact the printer already reported on the same link.
  const prior = previous ?? base;

  // A hostile or truncated geometry report is not a report: a 0 or 65535-dot
  // head would otherwise become geometry and a raster width. The print gate
  // then treats the fallback width as the guess it is.
  const usableHeadWidth = (value) =>
    Number.isFinite(value) && value > 0 && value <= CONFIG.geometry.maxHeadWidthPx;
  const reportedHeadWidth = [capabilities?.headWidthPx, heartbeat?.headWidthPx].find(usableHeadWidth) ?? null;
  const headWidthPx = reportedHeadWidth ?? prior.headWidthPx;
  const model = info.model ?? prior.model ?? modelFor(info.deviceType).name;
  const modelSupport = info.modelSupport ?? prior.modelSupport ?? null;
  const task = info.task ?? prior.task ?? null;
  // The TLV is preferred, but a value outside the printer's range is not a
  // resolution: keep a usable heartbeat class if there is one, otherwise the
  // dpi is absent and the geometry is a guess. A hostile value must never
  // reach `pitchFor`.
  const reportedDpis = [capabilities?.dpi, heartbeat?.dpi].filter(reported);
  const reportedDpi = reportedDpis.find(usableDpi) ?? null;
  const invalidDpi = reportedDpis.length > 0 && reportedDpi === null;
  const dpi = reportedDpi ?? (reportedDpis.length ? null : prior.dpi);
  const maxPrintHeightPx = capabilities?.maxPrintHeightPx ?? null;
  // A reported maximum below the shortest label the app can author is not a
  // usable limit: keep what the previous pass or the defaults established.
  const reportedLengthMm = maxPrintHeightPx ? Math.floor(maxPrintHeightPx / pitchFor({ dpi })) : null;
  const maxLengthMm = maxLengthFor(reportedLengthMm) ?? prior.maxLengthMm;

  const sensors = sensorsFrom(advanced) ?? prior.sensors;
  const battery = batteryFrom(advanced, info) ?? prior.battery;
  const rfidReported = reported(capabilities?.rfidRead) || reported(heartbeat?.rfidRead);

  const source = {
    model: reported(info.model) ? 'reported' : prior.source.model,
    // The gate's "reported" fact is the head width *and* a usable resolution.
    // A head-only frame has no pitch: the label size would be a guess, so it
    // must not claim to be reported and the gate must refuse to print. A
    // previously reported dpi counts (it is the same session's printer), and a
    // hostile dpi stays a default even with a usable head.
    headWidth: reportedHeadWidth !== null ? 'reported' : prior.source.headWidth,
    dpi: invalidDpi ? 'default' : reportedDpi !== null ? 'reported' : prior.source.dpi,
    geometry:
      invalidDpi || dpi === null
        ? 'default'
        : reportedHeadWidth !== null
          ? 'reported'
          : prior.source.geometry,
    density: reported(capabilities?.densityRange) || reported(info.density) ? 'reported' : prior.source.density,
    labelType: capabilities?.labelTypes?.length || reported(info.labelType) ? 'reported' : prior.source.labelType,
    battery: battery ? 'reported' : prior.source.battery,
    sensors: sensors ? 'reported' : prior.source.sensors,
    rfid: rfidReported ? 'reported' : prior.source.rfid,
    rtc: reported(capabilities?.hasRtc) ? 'reported' : prior.source.rtc,
    volume: reported(capabilities?.hasVolume) ? 'reported' : prior.source.volume,
    cutter: reported(capabilities?.hasCutter) ? 'reported' : prior.source.cutter,
    autoShutdown: reported(capabilities?.autoShutdownRange) || reported(info.autoShutdown) ? 'reported' : prior.source.autoShutdown,
  };

  return {
    ...base,
    model,
    modelSupport,
    task,
    deviceType: info.deviceType ?? prior.deviceType,
    serial: info.serial ?? prior.serial,
    firmware: heartbeat?.softwareVersion ?? info.softwareVersion ?? prior.firmware,
    hardware: heartbeat?.hardwareVersion ?? info.hardwareVersion ?? prior.hardware,
    protocolVersion: statusData?.protocolVersion ?? prior.protocolVersion,
    headWidthPx,
    dpi,
    maxLengthMm,
    density: info.density ?? prior.density,
    densityRange: capabilities?.densityRange ?? prior.densityRange,
    labelType: info.labelType ?? prior.labelType,
    labelTypes: capabilities?.labelTypes?.length ? capabilities.labelTypes : prior.labelTypes,
    rfid: {
      read: capabilities?.rfidRead ?? heartbeat?.rfidRead ?? prior.rfid.read,
      write: heartbeat?.rfidWrite ?? prior.rfid.write,
    },
    battery,
    sensors,
    autoShutdown: info.autoShutdown ?? prior.autoShutdown,
    autoShutdownRange: capabilities?.autoShutdownRange ?? prior.autoShutdownRange,
    // Null survives the merge: "unreported" must not render as "unsupported".
    hasRtc: capabilities?.hasRtc ?? prior.hasRtc,
    hasVolume: capabilities?.hasVolume ?? prior.hasVolume,
    hasCutter: capabilities?.hasCutter ?? prior.hasCutter,
    discovered: Boolean(heartbeat || capabilities),
    roll: roll ?? prior.roll,
    source,
  };
}

/**
 * Drop the readings that belong to the link that just ended. Identity, learned
 * features and geometry survive a disconnect; battery, sensors and the roll tag
 * describe "right now" and must not keep rendering as current.
 */
export function clearVolatileCapabilities(capabilities) {
  const base = capabilities ?? emptyCapabilities();
  return {
    ...base,
    battery: null,
    sensors: null,
    roll: null,
    source: { ...base.source, battery: 'default', sensors: 'default', rfid: 'default' },
  };
}

/**
 * Fold a fresh advanced-heartbeat sample into a capability model. One owner for
 * "the newest sensor/battery reading", used by the print gate and the UI.
 */
export function applyHeartbeatSample(capabilities, sample) {
  if (!sample) return capabilities;
  const sensors = sensorsFrom(sample) ?? capabilities.sensors;
  const battery = batteryFrom(sample, null) ?? capabilities.battery;
  if (sensors === capabilities.sensors && battery === capabilities.battery) return capabilities;
  return {
    ...capabilities,
    sensors,
    battery,
    source: { ...capabilities.source, sensors: sensors ? 'reported' : capabilities.source.sensors, battery: battery ? 'reported' : capabilities.source.battery },
  };
}

/** Human label for a label-type id, falling back to the raw id. */
export function labelTypeName(id) {
  return CONFIG.print.labelTypes[id] ?? `Type ${id}`;
}

/**
 * Clamp a value to the printer's advertised range. A range that is present but
 * not two finite numbers is malformed and yields the fallback; an absent range
 * means "no clamping", so the value passes through.
 */
export function clampToRange(value, range, fallback) {
  const numeric = Number.isFinite(value) ? value : fallback;
  if (!range) return numeric;
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) return fallback;
  return Number.isFinite(numeric) ? Math.min(range.max, Math.max(range.min, numeric)) : fallback;
}

/** Auto power-off choices, built from the range the printer reports. */
export function autoShutdownOptions(capabilities) {
  const labels = CONFIG.device.autoShutdownLabels;
  const range = capabilities?.autoShutdownRange;
  const values = range
    ? Array.from({ length: range.max - range.min + 1 }, (_, index) => range.min + index)
    : Object.keys(labels).map(Number);
  // The value the printer reports must always be selectable, even when it sits
  // outside the advertised range.
  const current = capabilities?.autoShutdown;
  if (Number.isFinite(current) && !values.includes(current)) values.push(current);
  values.sort((a, b) => a - b);
  return values.map((value) => [String(value), labels[value] ?? `Level ${value}`]);
}

/**
 * The paper-moving commands and the words a sensor refusal uses for each one.
 * The gate owns the sentence; a command names its action so a feed refusal
 * cannot claim "nothing was printed". Only the actions this app can actually
 * command exist here: an unused `advance` entry was dead configuration.
 */
const PAPER_ACTIONS = Object.freeze({
  print: Object.freeze({ verb: 'print', doing: 'printing', done: 'printed' }),
  feed: Object.freeze({ verb: 'feed', doing: 'feeding', done: 'fed' }),
});

/**
 * The one support gate. It answers whether this app may operate the printer,
 * and when it may not, why and which class of fact blocked it.
 *
 * The model gate is first: an unsupported model can never be used, and an
 * unknown model or a guessed head width is not a basis for a raster. Sensors
 * and battery are paper prerequisites, so they apply only when the caller asks
 * for them (`requiresPaper`); configuration commands still need a model and
 * real geometry. Sensors and battery are enforced only when the printer
 * actually reported them. The whole function is defensive: a hostile
 * capability object blocks, it never throws.
 *
 * @param {object|null|undefined} capabilities
 * @param {{requiresPaper?: boolean, action?: 'print'|'feed'}} [options]
 * @returns {{allowed: boolean, reason: string|null, kind: 'model'|'geometry'|'sensor'|null}}
 */
export function supportGate(capabilities, { requiresPaper = true, action = 'print' } = {}) {
  const blocked = (reason, kind) => ({ allowed: false, reason, kind });
  const allowed = { allowed: true, reason: null, kind: null };
  const support = capabilities?.modelSupport ?? 'unknown';
  if (support === 'unsupported') {
    return blocked(`${capabilities?.model ?? 'This printer'} is not supported. ${CONFIG.device.printGate.unsupported}`, 'model');
  }
  if (!capabilities?.model || support === 'unknown') return blocked(CONFIG.device.printGate.unknownModel, 'model');
  if (capabilities?.source?.geometry !== 'reported') {
    // Name the fact the printer withheld. A dpi-only report is not a missing
    // resolution, and a head-only report is not a missing head width; only the
    // both-missing case uses the general sentence.
    const marks = capabilities?.source ?? {};
    const headMissing = marks.headWidth !== 'reported';
    const dpiMissing = marks.dpi !== 'reported';
    const reason =
      headMissing && dpiMissing
        ? CONFIG.device.printGate.guessedGeometry
        : headMissing
          ? CONFIG.device.printGate.missingHeadWidth
          : CONFIG.device.printGate.missingResolution;
    return blocked(reason, 'geometry');
  }
  if (!requiresPaper) return allowed;
  const words = PAPER_ACTIONS[action] ?? PAPER_ACTIONS.print;
  const sensors = capabilities?.sensors;
  if (sensors) {
    if (!sensors.lidClosed) return blocked(`Close the printer lid before ${words.doing}; nothing was ${words.done}.`, 'sensor');
    if (!sensors.paperPresent) return blocked(`Load a label roll before ${words.doing}; nothing was ${words.done}.`, 'sensor');
  }
  const percent = capabilities?.battery?.percent;
  if (percent != null && percent <= CONFIG.device.battery.criticalPercent) {
    return blocked(`Battery is too low to ${words.verb} (${percent}%); nothing was ${words.done}.`, 'sensor');
  }
  return allowed;
}

/**
 * Why a print job must not start, or null when it may.
 *
 * This stays the single print answer: it delegates to the one support gate and
 * quotes its reason, so the manager, the flow and the buttons cannot drift.
 */
export function printBlockReason(capabilities) {
  return supportGate(capabilities).reason;
}
