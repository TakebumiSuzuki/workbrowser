import type { ActionReceipt, Result } from '../browser-control';
import { originOf, type Event, type Run } from './contracts';

const clip = (value: string, limit: number) => value.length <= limit ? value : value.slice(0, limit) + '…';
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

function targetOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const target = value as Record<string, unknown>;
  if (text(target.role)) return [target.role, text(target.name) ? `“${target.name}”` : undefined].filter(Boolean).join(' ');
  if (text(target.ref)) return `Element ${target.ref}`;
  return undefined;
}

/** Describe actual tool results, using resolved targets and masked read-back values, never raw typed arguments. */
export function activityEvent(tool: string, args: Record<string, unknown>, result: Result, sourceUrl?: string): Event {
  const data = result.data as { receipts?: ActionReceipt[]; url?: string } | undefined;
  const receipts = result.receipt ? [result.receipt] : Array.isArray(data?.receipts) ? data.receipts : [];
  const uncertain = receipts.some(receipt => receipt.dispatched === 'unknown' || receipt.reachedTarget === false || receipt.postcondition?.status === 'unmet');
  const failed = !result.ok || uncertain || !!result.pageError;
  let target = [...new Set(receipts.flatMap(receipt => receipt.target ? [receipt.target] : []))].join('\n') ||
    targetOf(args.target) || (Array.isArray(args.fields) ? args.fields.map(field => targetOf(field && typeof field === 'object' ? field.target : undefined)).filter(Boolean).join('\n') : undefined) ||
    (tool === 'navigate' ? text(args.url) : undefined) ||
    (tool === 'find' ? [text(args.role), text(args.name), text(args.text)].filter(Boolean).join(' · ') : undefined) ||
    (text(args.ref) ? `Element ${args.ref}` : undefined);
  const url = [result.page?.url, ...receipts.flatMap(receipt => receipt.navigation?.url ? [receipt.navigation.url] : []), text(data?.url), sourceUrl]
    .find((value): value is string => !!value && !!originOf(value));
  if (tool === 'navigate' && target === url) target = undefined;
  const labels: Record<string, string> = {
    navigate: args.action === 'back' ? 'Went back' : args.action === 'forward' ? 'Went forward' : args.action === 'reload' ? 'Reloaded page' : 'Opened page',
    click: 'Clicked', set: receipts[0]?.mechanism === 'select-option' ? 'Selected option' : receipts[0]?.mechanism === 'insert-text' ? 'Entered text' : receipts[0]?.mechanism === 'pointer' ? 'Changed control' : 'Set field value',
    type: 'Typed text', press: 'Pressed keys', fill_form: 'Filled form', hover: 'Hovered over',
    scroll: 'Scrolled', snapshot: 'Inspected page', read: args.ref ? 'Read element' : 'Read page',
    find: 'Searched for elements', screenshot: 'Captured labelled screenshot', wait: 'Waited',
  };
  let label = labels[tool] ?? tool;
  if (!result.ok) label = `${tool === 'navigate' ? 'Open page' : tool === 'click' ? 'Click' : label} failed`;
  else if (uncertain) label = `Could not verify ${tool === 'set' ? 'field change' : tool === 'fill_form' ? 'form changes' : tool}`;
  else if (result.pageError) label += ' — updated page unavailable';
  else if (receipts.length && receipts.every(receipt => receipt.dispatched === false)) label = 'No action needed';

  const details: string[] = [];
  for (const receipt of receipts) {
    if (receipt.postcondition?.detail) details.push(`${receipts.length > 1 && receipt.target ? receipt.target + ': ' : ''}${receipt.postcondition.detail}`);
    if (receipt.dispatched === 'unknown') details.push('It could not be verified whether input was sent.');
    else if (receipt.reachedTarget === false) details.push('Input did not reach the intended element.');
    else if (receipt.dispatched === false) details.push('No input was sent.');
    if (receipt.effect.verdict === 'none' && receipt.dispatched === true) details.push('No visible change was detected.');
    if (receipt.navigation && receipt.navigation.url !== url) details.push(`Navigation: ${receipt.navigation.url}`);
  }
  if (!result.ok) {
    details.push(result.error ? `${result.error.code}: ${result.error.message}` : result.text);
    if (result.error?.delivered === false) details.push('No input was sent.');
    else if (result.error?.delivered === true) details.push('Some input was sent before the error.');
    else if (result.error?.delivered === 'unknown') details.push('It could not be verified whether input was sent.');
  }
  if (result.pageError) details.push(`The updated page could not be read: ${result.pageError.message}`);
  if (tool === 'press' && text(args.keys)) details.unshift(`Keys: ${args.keys}`);
  if (tool === 'find' && result.ok && Array.isArray(result.data)) details.push(`${result.data.length} matching elements returned.`);
  if (tool === 'scroll') {
    if (text(args.to)) details.unshift(`Destination: ${args.to}`);
    const by = args.by as { pages?: number; px?: number } | undefined;
    if (typeof by?.pages === 'number') details.unshift(`${by.pages} page(s)`);
    if (typeof by?.px === 'number') details.unshift(`${by.px} px`);
  }
  if (tool === 'wait' && typeof args.ms === 'number') details.unshift(`${args.ms} ms`);
  const detail = [...new Set(details)].join('\n');
  return {
    at: new Date().toISOString(), label, status: failed ? 'error' : 'ok',
    action: { tool, ...(target ? { target: clip(target, 1000) } : {}), ...(url ? { url } : {}), ...(detail ? { detail: clip(detail, 1600) } : {}) },
  };
}

/** Keep the activity ledger bounded even when page URLs and read-back details are long. */
export function appendEvent(run: Run, event: Event): void {
  run.events.push(event);
  while (run.events.length > 500 || new TextEncoder().encode(JSON.stringify(run.events)).length > 96000) {
    run.events.shift(); run.activityTruncated = true;
  }
}
