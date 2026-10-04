/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  browser_fill_form against a real (headless) Chromium. Skipped when Playwright finds no
 *  browser; set NOVA_TEST_CHROMIUM to a chrome/chromium executable to choose one.
 *  Run: node --test out/test
 *-------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { after, before, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { fillFormFields, maskSecrets, PASSWORD_VALUES_SCRIPT, type INovaFormField } from '../formFill';

const FORM = `<!doctype html><html><body>
<form id="signup" onsubmit="window.submits++; return false">
	<label>Nome <input id="nome" name="nome"></label>
	<label for="email">E-mail</label><input id="email" type="email">
	<input id="senha" type="password" placeholder="Senha">
	<input id="cidade">
	<input id="fone" placeholder="(00) 00000-0000">
	<label><input id="aceite" type="checkbox"> Aceito</label>
	<select id="plano"><option value="free">Grátis</option><option value="pro">Profissional</option></select>
	<textarea id="obs"></textarea>
	<div id="extra"></div>
	<button type="submit">Enviar</button>
</form>
<script>
	window.submits = 0;
	window.changes = 0;
	document.addEventListener('change', () => window.changes++);
	// Masked phone input: keeps only digits and formats them as they are typed.
	document.getElementById('fone').addEventListener('input', e => {
		const d = e.target.value.replace(/\\D/g, '').slice(0, 11);
		e.target.value = d.length > 2 ? '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + (d.length > 7 ? '-' + d.slice(7) : '') : d;
	});
	// Choosing "pro" renders a field that did not exist before.
	document.getElementById('plano').addEventListener('change', e => {
		document.getElementById('extra').innerHTML = e.target.value === 'pro' ? '<input id="empresa">' : '';
	});
</script>
</body></html>`;

let browser: Browser | undefined;
let page: Page;

before(async () => {
	const { chromium } = await import('playwright-core');
	for (const options of [{ executablePath: process.env.NOVA_TEST_CHROMIUM }, {}, { channel: 'chrome' }]) {
		try {
			browser = await chromium.launch({ headless: true, ...options });
			break;
		} catch {
			// try the next way to find a browser
		}
	}
});

after(async () => {
	await browser?.close();
});

async function freshPage(): Promise<Page> {
	page = await browser!.newPage();
	await page.setContent(FORM);
	return page;
}

/** Current value of each element id. */
async function values(...ids: string[]): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const id of ids) {
		result[id] = await page.locator(`#${id}`).inputValue();
	}
	return result;
}

const resolve = (target: string) => target.startsWith('label=') ? page.getByLabel(target.slice(6)) : target.startsWith('placeholder=') ? page.getByPlaceholder(target.slice(12)) : page.locator(target);

test('fills eight fields of different kinds in one call, with change events and no submit', async t => {
	if (!browser) {
		return t.skip('no Chromium found for Playwright');
	}
	await freshPage();
	const fields: INovaFormField[] = [
		{ target: 'label=Nome', kind: 'text', value: 'Maria Teste' },
		{ target: 'label=E-mail', kind: 'text', value: 'maria@example.com' },
		{ target: 'placeholder=Senha', kind: 'text', value: 's3nh@-secreta' },
		{ target: '#cidade', kind: 'text', value: 'Aracaju' },
		{ target: '#fone', kind: 'text', value: '79999998888', slowly: true },
		{ target: '#aceite', kind: 'checkbox', checked: true },
		{ target: '#plano', kind: 'select', label: 'Profissional' },
		{ target: '#empresa', kind: 'text', value: 'EduCaju' }, // only exists after the select above
	];
	const result = await fillFormFields(resolve, fields);
	assert.deepStrictEqual(result, { total: 8, filled: 8 });
	const state = {
		...await values('nome', 'email', 'senha', 'cidade', 'fone'),
		aceite: await page.locator('#aceite').isChecked(),
		...await values('plano', 'empresa'),
		submits: await page.evaluate('window.submits'),
		changes: await page.evaluate('window.changes'),
	};
	assert.deepStrictEqual(state, {
		nome: 'Maria Teste', email: 'maria@example.com', senha: 's3nh@-secreta', cidade: 'Aracaju', fone: '(79) 99999-8888',
		aceite: true, plano: 'pro', empresa: 'EduCaju', submits: 0, changes: 8,
	});
	assert.ok(!JSON.stringify(result).includes('s3nh@'), 'the result never carries typed values');
	await page.close();
});

test('stops at the first failing field, keeps the earlier ones and leaves the later ones untouched', async t => {
	if (!browser) {
		return t.skip('no Chromium found for Playwright');
	}
	await freshPage();
	const result = await fillFormFields(resolve, [
		{ target: '#nome', kind: 'text', value: 'Ana' },
		{ target: '#cidade', kind: 'text', value: 'Recife' },
		{ target: '#nao-existe', kind: 'text', value: 'valor-sigiloso' },
		{ target: '#obs', kind: 'text', value: 'não deve ser escrito' },
	]);
	assert.deepStrictEqual({ ...result, error: undefined }, { total: 4, filled: 2, failedIndex: 2, failedTarget: '#nao-existe', errorCategory: 'not-found', error: undefined });
	assert.ok(!result.error!.includes('valor-sigiloso'));
	assert.deepStrictEqual(await values('nome', 'cidade', 'obs'), { nome: 'Ana', cidade: 'Recife', obs: '' });
	await page.close();
});

test('invalid requests change nothing on the page', async t => {
	if (!browser) {
		return t.skip('no Chromium found for Playwright');
	}
	await freshPage();
	const staleRef = await fillFormFields(resolve, [{ target: '#nome', kind: 'text', value: 'X' }, { target: 'aria-ref=e12', kind: 'text', value: 'Y' }]);
	const noOption = await fillFormFields(resolve, [{ target: '#plano', kind: 'select' }]);
	const tooMany = await fillFormFields(resolve, Array.from({ length: 21 }, () => ({ target: '#nome', kind: 'text' as const, value: 'Z' })));
	assert.deepStrictEqual(
		[staleRef, noOption, tooMany].map(r => [r.filled, r.failedIndex, r.errorCategory]),
		[[0, 1, 'invalid-target'], [0, 0, 'invalid-target'], [0, undefined, 'invalid-target']]
	);
	assert.strictEqual(await page.locator('#nome').inputValue(), '');
	await page.close();
});

test('password values are masked in the ARIA snapshot; short values never garble error messages', async t => {
	if (!browser) {
		return t.skip('no Chromium found for Playwright');
	}
	await freshPage();
	await fillFormFields(resolve, [{ target: '#senha', kind: 'text', value: 's3nh@-secreta' }, { target: '#cidade', kind: 'text', value: 'Lagarto' }]);
	const raw = await page.locator('form').ariaSnapshot();
	assert.ok(raw.includes('s3nh@-secreta'), 'Playwright itself shows the password');
	const masked = maskSecrets(raw, await page.evaluate(PASSWORD_VALUES_SCRIPT) as string[]);
	assert.ok(!masked.includes('s3nh@-secreta') && masked.includes('••••••') && masked.includes('Lagarto'), masked);
	const missing = await fillFormFields(resolve, [{ target: '#nao-existe', kind: 'text', value: 'x' }]);
	assert.ok(missing.error!.includes('exceeded'), missing.error);
	await page.close();
});

test('a field that cannot take the value is reported as not editable', async t => {
	if (!browser) {
		return t.skip('no Chromium found for Playwright');
	}
	await freshPage();
	const result = await fillFormFields(resolve, [{ target: '#aceite', kind: 'text', value: 'abc' }]);
	assert.deepStrictEqual([result.filled, result.failedIndex, result.errorCategory], [0, 0, 'not-editable']);
	await page.close();
});
