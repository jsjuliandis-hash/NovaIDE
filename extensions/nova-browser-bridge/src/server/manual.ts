/*---------------------------------------------------------------------------------------------
 *  Nova IDE — nova-browser-bridge
 *  Pure helpers over the Nova IDE manual (media/nova-ide/SKILL.md): pick one section by topic,
 *  and extract the short "Quick rules" section sent to agents at the start of a session.
 *  No vscode import, so the unit tests can run them under plain Node.
 *-------------------------------------------------------------------------------------------*/

/** How much of the manual an agent receives with the first prompt of a session. */
export type ManualMode = 'compact' | 'full' | 'off';

const COMPACT_START = '<!-- nova:compact:start -->';
const COMPACT_END = '<!-- nova:compact:end -->';

/** Short words agents tend to ask for, mapped to part of the matching `##` heading. */
const TOPIC_ALIASES: Record<string, string> = {
	browser: 'integrated browser',
	navegador: 'integrated browser',
	web: 'integrated browser',
	page: 'integrated browser',
	pagina: 'integrated browser',
	ide: 'acting on the ide',
	ui: 'acting on the ide',
	interface: 'acting on the ide',
	tab: 'acting on the ide',
	aba: 'acting on the ide',
	terminal: 'terminals',
	terminais: 'terminals',
	cli: 'terminals',
	files: 'showing things',
	file: 'showing things',
	arquivos: 'showing things',
	arquivo: 'showing things',
	image: 'showing things',
	imagem: 'showing things',
	chat: 'chat panel',
	quick: 'quick rules',
	rules: 'quick rules',
	resumo: 'quick rules',
};

/** The `##` sections of the manual, each starting with its heading line. */
function splitSections(manual: string): string[] {
	return manual.split(/^(?=## )/m).filter(part => part.startsWith('## '));
}

function headingOf(section: string): string {
	return section.split('\n', 1)[0].slice(3).trim();
}

/** Headings of the `##` sections, for the "unknown topic" answer. */
export function listManualTopics(manual: string): string[] {
	return splitSections(manual).map(headingOf);
}

/**
 * The whole manual when `topic` is empty, else the `##` section whose heading contains `topic`
 * (or one of its aliases). An unknown topic gets the list of topics instead of the whole
 * manual, so a typo does not cost thousands of characters.
 */
export function selectManualSection(manual: string, topic: string | undefined): string {
	const wanted = topic?.trim().toLowerCase();
	if (!wanted) {
		return manual;
	}
	const sections = splitSections(manual);
	const find = (needle: string) => sections.find(section => headingOf(section).toLowerCase().includes(needle));
	// An alias wins over a plain substring match: "ui" is also part of "Quick rules".
	const alias = TOPIC_ALIASES[wanted];
	const section = (alias ? find(alias) : undefined) ?? find(wanted);
	if (section) {
		return stripMarkers(section).trim();
	}
	return [
		`No manual section matches "${topic}".`,
		`Topics: ${sections.map(headingOf).join('; ')}.`,
		'Call ide_manual with one of them, or without a topic for the whole manual.',
	].join('\n');
}

/** The text between the compact markers of the manual, or undefined if the markers are missing. */
export function extractCompactManual(manual: string): string | undefined {
	const start = manual.indexOf(COMPACT_START);
	const end = manual.indexOf(COMPACT_END);
	if (start < 0 || end <= start) {
		return undefined;
	}
	return manual.slice(start + COMPACT_START.length, end).trim();
}

/**
 * The manual as an agent should receive it for `mode`: the quick rules, the whole file without
 * them (they only summarize the rest), or nothing.
 */
export function manualForMode(manual: string, mode: ManualMode): string | undefined {
	switch (mode) {
		case 'off': return undefined;
		case 'full': return withoutQuickRules(manual);
		default: return extractCompactManual(manual) ?? manual;
	}
}

function withoutQuickRules(manual: string): string {
	const start = manual.search(/^## Quick rules/m);
	const end = manual.indexOf(COMPACT_END);
	return start >= 0 && end > start ? manual.slice(0, start) + manual.slice(end + COMPACT_END.length).replace(/^\s+/, '') : manual;
}

function stripMarkers(text: string): string {
	return text.replace(COMPACT_START, '').replace(COMPACT_END, '');
}
