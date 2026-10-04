/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  browser_fill_form: fills several fields of a page in one tool call. Kept free of the vscode
 *  API so it can be tested against a real Chromium with plain Playwright.
 *-------------------------------------------------------------------------------------------*/

import type { Locator } from 'playwright-core';

/** One field of browser_fill_form. A target is a Playwright selector, `label=<text>` or `placeholder=<text>`. */
export type INovaFormField =
	| { target: string; kind: 'text'; value: string; slowly?: boolean }
	| { target: string; kind: 'checkbox'; checked: boolean }
	| { target: string; kind: 'select'; value?: string; label?: string };

export type INovaFormErrorCategory = 'invalid-target' | 'not-found' | 'ambiguous' | 'not-editable' | 'timeout' | 'other';

/** Outcome of browser_fill_form. It never contains the values that were typed. */
export interface INovaFillFormResult {
	total: number;
	filled: number;
	failedIndex?: number;
	failedTarget?: string;
	errorCategory?: INovaFormErrorCategory;
	error?: string;
	summary?: string;
}

interface FieldFailure {
	errorCategory: INovaFormErrorCategory;
	error: string;
}

/** Expression that lists the values typed in the password fields of a page (evaluated in the page). */
export const PASSWORD_VALUES_SCRIPT = `Array.from(document.querySelectorAll('input[type="password"]')).map(input => input.value).filter(value => value.length > 0)`;

/** Replaces every password value in `text` (an ARIA snapshot shows what is typed in password fields too). */
export function maskSecrets(text: string, secrets: readonly string[]): string {
	return [...secrets].sort((a, b) => b.length - a.length).reduce((masked, secret) => masked.split(secret).join('••••••'), text);
}

/** Most fields browser_fill_form accepts in one call. */
export const MAX_FORM_FIELDS = 20;

/** How long one field may take to appear and accept its value. */
export const FIELD_TIMEOUT_MS = 5_000;

/**
 * Fills `fields` in order. Each target is resolved again right before it is used, because
 * filling one field can re-render the next. It only types, checks and selects: it never clicks,
 * presses Enter or submits. It stops at the first failure and never retries, so a partly
 * filled form is reported as such instead of being filled twice.
 */
export async function fillFormFields(resolve: (target: string) => Locator, fields: readonly INovaFormField[]): Promise<INovaFillFormResult> {
	const result: INovaFillFormResult = { total: fields.length, filled: 0 };
	const invalid = validateFormFields(fields);
	if (invalid) {
		return { ...result, ...invalid };
	}
	for (const [index, field] of fields.entries()) {
		const failure = await fillField(resolve(field.target), field);
		if (failure) {
			return { ...result, failedIndex: index, failedTarget: field.target, ...failure };
		}
		result.filled++;
	}
	return result;
}

/** Checks every field before touching the page, so a bad request changes nothing. */
function validateFormFields(fields: readonly INovaFormField[]): (FieldFailure & { failedIndex?: number; failedTarget?: string }) | undefined {
	if (fields.length === 0) {
		return { errorCategory: 'invalid-target', error: 'No fields to fill.' };
	}
	if (fields.length > MAX_FORM_FIELDS) {
		return { errorCategory: 'invalid-target', error: `At most ${MAX_FORM_FIELDS} fields per call; split the form in two calls.` };
	}
	for (const [index, field] of fields.entries()) {
		const fail = (error: string) => ({ failedIndex: index, failedTarget: field.target, errorCategory: 'invalid-target' as const, error });
		if (!field.target?.trim()) {
			return fail('Empty target.');
		}
		// Snapshot refs are renumbered when the page changes, and filling a field can change it.
		if (field.target.startsWith('aria-ref=')) {
			return fail('aria-ref targets can go stale while the form is being filled; use a CSS selector, label=<text> or placeholder=<text>.');
		}
		if (field.kind === 'select' && field.value === undefined && field.label === undefined) {
			return fail('A select field needs value or label.');
		}
	}
	return undefined;
}

async function fillField(locator: Locator, field: INovaFormField): Promise<FieldFailure | undefined> {
	try {
		await locator.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
	} catch (error) {
		return categorize(error, undefined, 'not-found'); // waiting never echoes the value
	}
	try {
		const options = { timeout: FIELD_TIMEOUT_MS };
		switch (field.kind) {
			case 'text':
				if (field.slowly) {
					// Key by key, for masked inputs that format the value as it is typed.
					await locator.fill('', options);
					await locator.pressSequentially(field.value, { ...options, delay: 20 });
				} else {
					await locator.fill(field.value, options);
				}
				// Leaving the field fires change/blur, as a user moving to the next field would.
				await locator.blur(options);
				break;
			case 'checkbox':
				await locator.setChecked(field.checked, options);
				break;
			case 'select':
				await locator.selectOption(field.value !== undefined ? { value: field.value } : { label: field.label! }, options);
				break;
		}
		return undefined;
	} catch (error) {
		return categorize(error, field, 'timeout');
	}
}

/** First line of the Playwright error (its call log can be long), with the typed value masked. */
function categorize(error: unknown, field: INovaFormField | undefined, timeoutCategory: INovaFormErrorCategory): FieldFailure {
	let message = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0];
	// Very short values would mask parts of ordinary words ("x" in "exceeded").
	if (field?.kind === 'text' && field.value.length >= 4) {
		message = message.split(field.value).join('***');
	}
	let errorCategory: INovaFormErrorCategory = 'other';
	if (/strict mode violation/i.test(message)) {
		errorCategory = 'ambiguous';
	} else if (/not an? <?(input|textarea|select|checkbox|radio)|not editable|not a checkbox|cannot be (filled|checked|unchecked)|disabled|readonly/i.test(message)) {
		errorCategory = 'not-editable';
	} else if ((error as { name?: string } | undefined)?.name === 'TimeoutError' || /timeout/i.test(message)) {
		errorCategory = timeoutCategory;
	}
	return { errorCategory, error: message };
}
