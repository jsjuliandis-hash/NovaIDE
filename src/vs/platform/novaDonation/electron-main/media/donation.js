/*---------------------------------------------------------------------------------------------
 *  Nova IDE
 *  Donation popup: copy the Live Pix link and close the window.
 *-------------------------------------------------------------------------------------------*/

// @ts-check
(function () {
	'use strict';

	const pixInput = /** @type {HTMLInputElement} */ (document.getElementById('pixInput'));
	const copyNotice = document.getElementById('copyNotice');
	let noticeTimer = 0;

	const version = new URLSearchParams(window.location.search).get('version');
	const versionTag = document.getElementById('version');
	if (version && versionTag) {
		versionTag.textContent = `v${version}`;
		versionTag.hidden = false;
	}

	async function copyPixLink() {
		const text = `https://${pixInput.value}`;
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			pixInput.value = text;
			pixInput.select();
			document.execCommand('copy');
			pixInput.value = text.replace(/^https:\/\//, '');
		}
		if (copyNotice) {
			copyNotice.classList.add('visible');
			clearTimeout(noticeTimer);
			noticeTimer = window.setTimeout(() => copyNotice.classList.remove('visible'), 2400);
		}
	}

	document.getElementById('copyPixBtn')?.addEventListener('click', copyPixLink);
	document.getElementById('copyPixQuickBtn')?.addEventListener('click', copyPixLink);
	document.getElementById('closeButton')?.addEventListener('click', () => window.close());
	document.getElementById('laterButton')?.addEventListener('click', () => window.close());
	window.addEventListener('keydown', e => {
		if (e.key === 'Escape') {
			window.close();
		}
	});
})();
