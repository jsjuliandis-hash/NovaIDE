/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Tests of how answers are cut into pieces for the voice and of the queue that synthesizes them ahead of the audio.
 *-------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TextToSpeechStatus } from '../../../speech/common/speechService.js';
import { INovaAudioPlayer, NovaTextToSpeechSession, splitForSynthesis } from '../../electron-browser/novaTextToSpeech/novaTextToSpeechService.js';

suite('Nova text to speech: splitForSynthesis', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps short text in one piece and replaces links', () => {
		assert.deepStrictEqual(splitForSynthesis('Veja https://example.com/a?b=1 agora. Depois volte.', 100), ['Veja link agora. Depois volte.']);
	});

	test('never reads asterisks', () => {
		assert.deepStrictEqual(splitForSynthesis('Isto é **muito** importante, *sim*. 2*3 é seis.', 100), ['Isto é muito importante, sim . 2 3 é seis.']);
	});

	test('never reads arrows', () => {
		assert.deepStrictEqual(splitForSynthesis('Passo um → passo dois ⇒ fim ⟶ ok ↔ certo.', 100), ['Passo um passo dois fim ok certo.']);
	});

	test('never reads backticks', () => {
		assert.deepStrictEqual(splitForSynthesis('Rode `npm test` e depois ```ok```.', 100), ['Rode npm test e depois ok .']);
	});

	test('never reads slashes, backslashes or emojis', () => {
		assert.deepStrictEqual(splitForSynthesis('Use e/ou C:\\pasta 🚀 e 👍🏽 pronto ✅.', 100), ['Use e ou C: pasta e pronto .']);
	});

	test('spells out file names, paths and line numbers', () => {
		assert.deepStrictEqual(splitForSynthesis('Alterei novaTextToSpeechService.ts e o arquivo src/vs/platform/novaTts.test.ts:245 também.', 200), [
			'Alterei nova Text To Speech Service ponto ts e o arquivo src vs platform nova Tts ponto test ponto ts, linha 245 também.',
		]);
		assert.deepStrictEqual(splitForSynthesis('Veja C:\\dev\\meu-app\\index.js:10:4 agora.', 200), ['Veja C dev meu app index ponto js, linha 10 agora.']);
	});

	test('leaves ordinary text with dots alone', () => {
		assert.deepStrictEqual(splitForSynthesis('São 3.5 mil reais. Fim.Depois vem o resto, e.g. isto. O HTMLParser lê.', 200), ['São 3.5 mil reais. Fim.Depois vem o resto, e.g. isto. O HTMLParser lê.']);
	});

	test('cuts at sentence ends when the text is longer than the limit', () => {
		assert.deepStrictEqual(splitForSynthesis('Primeira frase aqui. Segunda frase aqui. Terceira.', 25), ['Primeira frase aqui.', 'Segunda frase aqui.', 'Terceira.']);
	});

	test('cuts a sentence that is longer than the limit and drops pieces with nothing to read', () => {
		assert.deepStrictEqual(splitForSynthesis('abcdefghij\n---\n***', 4), ['abcd', 'efgh', 'ij']);
	});
});

suite('Nova text to speech: session queue', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	class FakePlayer extends Disposable implements INovaAudioPlayer {
		readonly enqueued: string[] = [];
		stopped = false;
		isBusy = false;
		private readonly _idle = this._register(new Emitter<void>());
		readonly onDidBecomeIdle = this._idle.event;
		async enqueue(audioBase64: string): Promise<number> {
			this.enqueued.push(audioBase64);
			return 0;
		}
		stop(): void {
			this.stopped = true;
		}
	}

	function setup(prefetch: number, token: CancellationToken = CancellationToken.None) {
		const player = store.add(new FakePlayer());
		const started: string[] = [];
		const answers = new Map<string, DeferredPromise<string>>();
		const events: TextToSpeechStatus[] = [];
		const session = store.add(new NovaTextToSpeechSession(
			token,
			async () => () => { },
			text => {
				started.push(text);
				const answer = new DeferredPromise<string>();
				answers.set(text, answer);
				return answer.p;
			},
			2500,
			prefetch,
			() => { },
			undefined,
			player,
		));
		store.add(session.onDidChange(e => events.push(e.status)));
		return { player, started, answers, events, session };
	}

	const A = 'a'.repeat(310) + '.';
	const B = 'b'.repeat(310) + '.';
	const C = 'c'.repeat(310) + '.';

	test('synthesizes one piece ahead and plays the pieces in reading order', async () => {
		const { player, started, answers, events, session } = setup(1);
		await session.synthesize(A);
		await session.synthesize(B);
		await session.synthesize(C);
		await timeout(0);
		const startedBeforeAnything = [...started];

		answers.get(B)!.complete('audio-B');
		await timeout(0);
		const enqueuedWhileAIsPending = [...player.enqueued];

		answers.get(A)!.complete('audio-A');
		await timeout(0);
		const startedAfterA = [...started];

		answers.get(C)!.complete('audio-C');
		await timeout(0);
		session.finish();
		await timeout(0);

		assert.deepStrictEqual({
			startedBeforeAnything,
			enqueuedWhileAIsPending,
			startedAfterA,
			enqueued: player.enqueued,
			events,
		}, {
			startedBeforeAnything: [A, B],
			enqueuedWhileAIsPending: [],
			startedAfterA: [A, B, C],
			enqueued: ['audio-A', 'audio-B', 'audio-C'],
			events: [TextToSpeechStatus.Started, TextToSpeechStatus.Stopped],
		});
	});

	test('does not work ahead when the prefetch is zero', async () => {
		const { started, answers, session } = setup(0);
		await session.synthesize(A);
		await session.synthesize(B);
		await timeout(0);
		const before = [...started];
		answers.get(A)!.complete('audio-A');
		await timeout(0);
		assert.deepStrictEqual({ before, after: started }, { before: [A], after: [A, B] });
	});

	test('joins short pieces that wait in the queue, but never into the first one', async () => {
		const { started, answers, session } = setup(0);
		await session.synthesize('Primeira frase.');
		await session.synthesize('Segunda frase.');
		await session.synthesize('Terceira frase.');
		await timeout(0);
		const before = [...started];
		answers.get('Primeira frase.')!.complete('audio-1');
		await timeout(0);
		// The first piece never waits for company; the two that waited behind it become one request.
		assert.deepStrictEqual({ before, after: started }, { before: ['Primeira frase.'], after: ['Primeira frase.', 'Segunda frase. Terceira frase.'] });
	});

	test('ends the session when the answer has nothing to read', async () => {
		const { events, session } = setup(1);
		await session.synthesize('***');
		session.finish();
		await timeout(0);
		assert.deepStrictEqual(events, [TextToSpeechStatus.Started, TextToSpeechStatus.Stopped]);
	});

	test('plays nothing that finishes after the session was cancelled', async () => {
		const cancellation = store.add(new CancellationTokenSource());
		const { player, answers, events, session } = setup(1, cancellation.token);
		await session.synthesize(A);
		await session.synthesize(B);
		await timeout(0);
		cancellation.cancel();
		answers.get(A)!.complete('audio-A');
		answers.get(B)!.complete('audio-B');
		await timeout(0);
		assert.deepStrictEqual({ enqueued: player.enqueued, stopped: player.stopped, events }, { enqueued: [], stopped: true, events: [TextToSpeechStatus.Started, TextToSpeechStatus.Stopped] });
	});

	test('reports a failed piece once and stops', async () => {
		const player = store.add(new FakePlayer());
		const errors: unknown[] = [];
		const events: TextToSpeechStatus[] = [];
		const session = store.add(new NovaTextToSpeechSession(CancellationToken.None, async () => () => { }, async () => { throw new Error('boom'); }, 2500, 1, error => errors.push(error), undefined, player));
		store.add(session.onDidChange(e => events.push(e.status)));
		await session.synthesize(A);
		await session.synthesize(B);
		await timeout(0);
		assert.deepStrictEqual({ errors: errors.map(e => (e as Error).message), events, enqueued: player.enqueued }, { errors: ['boom'], events: [TextToSpeechStatus.Started, TextToSpeechStatus.Error, TextToSpeechStatus.Stopped], enqueued: [] });
	});
});
