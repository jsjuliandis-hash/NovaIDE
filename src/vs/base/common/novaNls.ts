/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Translations for `localize()` strings that Nova adds to the core. The official language
 *  packs know nothing about them, so they are merged in when messages are generated: by
 *  src/vs/base/node/nls.ts in packaged builds and by build/nova/devNls.ts in dev builds.
 *-------------------------------------------------------------------------------------------*/

/**
 * language → module id (path under src/, no extension) → localize key → translation.
 */
export const novaTranslations: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
	'pt-br': {
		'vs/workbench/contrib/chat/browser/chatSessions/chatSessionPickerActionItem': {
			'nova.chatSessionPicker.search': 'Pesquisar {0}',
			'nova.chatSessionPicker.favorites': 'Favoritos',
			'nova.chatSessionPicker.all': 'Todos',
			'nova.chatSessionPicker.addFavorite': 'Adicionar aos Favoritos',
			'nova.chatSessionPicker.removeFavorite': 'Remover dos Favoritos',
		},
		'vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA': {
			'onboarding.a.aria.nova': 'Bem-vindo à Nova IDE',
		},
	},
};
