/** Types for case-reference.js (the browser loads the JavaScript; tests and typecheck read this declaration). */
import type { CaseReferenceRequest } from '../../../contract/schemas.ts';

/** What the officer has typed into the Record merchant confirmation form. */
export interface CaseReferenceDraft {
  readonly hosts: string;
  readonly note: string;
}

export function initialCaseReferenceDraft(): CaseReferenceDraft;
export function parsePaymentHosts(text: string): string[];
export function caseReferenceRequest(draft: CaseReferenceDraft): CaseReferenceRequest | null;
