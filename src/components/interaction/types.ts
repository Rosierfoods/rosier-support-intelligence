/** Result shape returned by every review server action (used with useActionState). */
export type ActionResult = { ok: true; message?: string } | { ok: false; error: string } | null;
export type FormAction = (prev: ActionResult, formData: FormData) => Promise<ActionResult>;

export interface FlagMarker { id: string; title: string; severity: string; reason: string; status: string }

/** id of the bulk-action form on the alert queue; row checkboxes join it via form=… */
export const BULK_FORM_ID = 'bulk-flags';
