/**
 * The one disconnect report.
 *
 * A link that drops while the print flow is preparing sent no frame, so the
 * label cannot be incomplete. A drop after the job started may have cut the
 * label, unless printEnd was already committed, which is the finishing phase:
 * the job is on the printer and only its status refresh was lost. The flow
 * exposes the phase and this owner owns the copy and the single toast; the
 * print flow itself stays silent for a lost link so the operator hears one
 * specific message, not that message plus a generic failure.
 */

import { toast } from './toast.js';

const COPY = Object.freeze({
  preparing: Object.freeze({
    status: 'Disconnected while preparing',
    message: 'Disconnected while preparing; nothing was printed.',
  }),
  printing: Object.freeze({
    status: 'Disconnected during print',
    message: 'Disconnected during print: the label may be incomplete',
  }),
  finishing: Object.freeze({
    status: 'Disconnected after printing',
    message: 'Disconnected after printing; the label was printed.',
  }),
  // The page counter confirmed every copy and printEnd was on the wire, but
  // the ack never arrived. This is not "may be incomplete": the printer counted
  // the label, and only the end-of-job confirmation was lost.
  committed: Object.freeze({
    status: 'Disconnected before the job ended',
    message:
      'The printer counted the label as printed, but the link dropped before it confirmed the end of the job. Reconnect before printing again.',
  }),
});

/**
 * Report a lost link: one status line and, while a job phase is active, one
 * error toast. An idle disconnect is status only.
 *
 * @param {{phase?: 'idle'|'preparing'|'printing'|'finishing', committed?: boolean,
 *          setStatus?: Function, notify?: Function}} options `committed` is the
 *        job's terminal-commit fact when the flow had not reached `finishing`
 * @returns {string|null} the toast message, or null for an idle disconnect
 */
export function reportDisconnect({ phase = 'idle', committed = false, setStatus = () => {}, notify = toast } = {}) {
  // A true print-phase uncertainty stays uncertain; a committed job that was
  // still printing from the flow's point of view gets the counted-label copy.
  const effective = committed && phase === 'printing' ? 'committed' : phase;
  const copy = COPY[effective];
  if (!copy) {
    setStatus('Disconnected');
    return null;
  }
  setStatus(copy.status);
  notify(copy.message, { tone: 'error' });
  return copy.message;
}
