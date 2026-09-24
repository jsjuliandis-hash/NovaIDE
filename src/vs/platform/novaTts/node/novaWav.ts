/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  WAV container for the raw PCM that Piper writes.
 *-------------------------------------------------------------------------------------------*/

/** Adds a 44-byte WAV header to raw 16-bit mono PCM. Exported for tests. */
export function wrapPcmAsWav(pcm: Buffer, sampleRate: number): Buffer {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write('data', 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}
