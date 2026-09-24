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
		'vs/workbench/contrib/chat/browser/speechToText/novaCloudTranscription': {
			'nova.dictation.groqLabel': 'Groq Whisper',
			'nova.dictation.googleLabel': 'Google Gemini',
			'nova.dictation.cloudLabel': 'Nuvem',
			'nova.dictation.current': 'atual',
			'nova.dictation.free': 'grátis',
			'nova.dictation.pickGroq': 'Groq — Whisper Large v3 Turbo',
			'nova.dictation.pickGroqDetail': 'O mais rápido e muito preciso. Chave de API gratuita em console.groq.com/keys',
			'nova.dictation.pickGoogle': 'Google — Gemini Flash',
			'nova.dictation.pickGoogleDetail': 'Chave de API gratuita em aistudio.google.com/apikey',
			'nova.dictation.pickLocal': 'Modelo local (roda neste computador)',
			'nova.dictation.pickLocalDetail': 'Sem chave de API. Mais lento sem placa NVIDIA.',
			'nova.dictation.pickTitle': 'Ditado: como sua voz deve ser transcrita?',
			'nova.dictation.pickPlaceholder': 'Escolha um provedor abaixo ou cole sua chave de API aqui. Seu áudio é enviado ao provedor, e só enquanto você dita.',
			'nova.dictation.keyTitleGroq': 'Chave de API do Groq',
			'nova.dictation.keyTitleGoogle': 'Chave de API do Google Gemini',
			'nova.dictation.keyPromptGroq': 'Cole sua chave de console.groq.com/keys (começa com gsk_)',
			'nova.dictation.keyPromptGoogle': 'Cole sua chave de aistudio.google.com/apikey',
			'nova.dictation.keyKeep': 'Deixe vazio para manter a chave salva',
			'nova.dictation.keyPlaceholder': 'Chave de API',
			'nova.dictation.keyRequired': 'Cole uma chave de API para continuar.',
			'nova.dictation.saved': 'O ditado agora usa {0}.',
			'nova.dictation.keyInvalid': 'O provedor recusou essa chave. Confira e cole de novo.',
			'nova.dictation.keyHttp': 'O provedor respondeu com erro ({0}). Tente de novo.',
			'nova.dictation.keyNetwork': 'Não foi possível acessar o provedor. Verifique sua conexão com a internet e tente de novo.',
			'nova.dictation.noKey': 'Nenhuma chave de API foi definida para o ditado em nuvem.',
			'nova.dictation.tooLarge': 'Esta gravação é longa demais para o plano gratuito de {0}. Dite em partes menores.',
			'nova.dictation.network': 'Não foi possível acessar {0}. Verifique sua conexão com a internet.',
			'nova.dictation.authFailed': '{0} recusou a chave de API.',
			'nova.dictation.rateLimit': 'Limite do plano gratuito de {0} atingido. Aguarde um instante e tente de novo.',
			'nova.dictation.httpError': '{0} retornou um erro ({1}).',
		},
		'vs/workbench/contrib/chat/browser/actions/chatSpeechToTextActions': {
			'nova.dictation.configure': 'Configurar Ditado',
		},
		'vs/workbench/contrib/chat/browser/speechToText/micButtonMenuActions': {
			'nova.dictation.menu.configure': 'Configurar Ditado (Provedor e Chave de API)',
		},
		'vs/workbench/contrib/chat/browser/speechToText/micButtonHovers': {
			'dictation.hover.novaCloud': 'Digita o que você fala no campo. Transcreve na nuvem com {0}, usando sua chave de API. Use a engrenagem para mudar.',
		},
		'vs/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService': {
			'nova.dictation.reconfigure': 'Configurar Ditado',
		},
	},
};
