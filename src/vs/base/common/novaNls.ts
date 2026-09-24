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
		'vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewTabs': {
			'nova.chatTabs.closeRunning': 'A sessão desta aba ainda está em andamento.',
			'nova.chatTabs.closeRunningDetail': 'Ela pode terminar em segundo plano e continuar disponível na lista de sessões.',
			'nova.chatTabs.keepRunning': '&&Deixar Terminar em Segundo Plano',
			'nova.chatTabs.stop': '&&Parar e Fechar',
			'nova.chatTabs.newChat': 'Novo Chat',
			'nova.chatTabs.local': 'Local',
			'nova.chatTabs.new': 'Nova Aba de Chat',
			'nova.chatTabs.needsInput': 'Aguardando você',
			'nova.chatTabs.running': 'Trabalhando…',
			'nova.chatTabs.finished': 'Concluído',
			'nova.chatTabs.title': 'Abas de Chat',
			'nova.chatTabs.newTab': 'Nova Aba de Chat',
			'nova.chatTabs.category': 'Chat',
			'nova.chatTabs.closeTab': 'Fechar Aba de Chat',
			'nova.chatTabs.nextTab': 'Próxima Aba de Chat',
			'nova.chatTabs.previousTab': 'Aba de Chat Anterior',
		},
		'vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA': {
			'onboarding.a.aria.nova': 'Bem-vindo à Nova IDE',
		},
	},
};
