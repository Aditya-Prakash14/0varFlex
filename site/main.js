// site/main.js — the motion + interaction layer.
//
// Everything is progressive: initial hidden states are applied by this file (never by load-order
// CSS alone), GSAP is optional, and prefers-reduced-motion gets the finished layout immediately.
// If the GSAP CDN never answers, `.no-anim` un-hides the page and the site stays whole.

(() => {
	'use strict';

	const root = document.documentElement;
	const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const gsap = window.gsap;
	const ScrollTrigger = window.ScrollTrigger;
	let motionStarted = false;

	const revealEverything = () => root.classList.add('no-anim');
	if (gsap && ScrollTrigger) {
		gsap.registerPlugin(ScrollTrigger);
	} else {
		revealEverything();
	}
	// belt and braces: if motion never actually started (threw, stalled, blocked), show the page
	window.setTimeout(() => { if (!motionStarted) { revealEverything(); } }, 3500);

	/* ---- interactions (no GSAP required) ---------------------------------- */

	// sticky nav state
	const nav = document.querySelector('.nav');
	const onScroll = () => nav && nav.classList.toggle('is-scrolled', window.scrollY > 8);
	onScroll();
	window.addEventListener('scroll', onScroll, { passive: true });

	// mobile menu
	const toggle = document.querySelector('.nav-toggle');
	if (toggle && nav) {
		const setOpen = open => {
			nav.classList.toggle('is-open', open);
			toggle.setAttribute('aria-expanded', String(open));
			toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
		};
		toggle.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
		document.querySelectorAll('.nav-links a').forEach(link => link.addEventListener('click', () => setOpen(false)));
		window.addEventListener('keydown', event => { if (event.key === 'Escape') { setOpen(false); } });
	}

	// copy buttons
	document.querySelectorAll('[data-copy]').forEach(button => {
		button.addEventListener('click', async () => {
			const source = document.querySelector(button.getAttribute('data-copy'));
			const text = source ? source.textContent.trim() : '';
			const label = button.querySelector('.copy-label');
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				const area = document.createElement('textarea');
				area.value = text;
				area.style.position = 'fixed';
				area.style.opacity = '0';
				document.body.appendChild(area);
				area.select();
				try { document.execCommand('copy'); } catch { /* nothing else to try */ }
				area.remove();
			}
			button.classList.add('is-copied');
			if (label) {
				const previous = label.textContent;
				label.textContent = 'Copied';
				window.setTimeout(() => { label.textContent = previous; button.classList.remove('is-copied'); }, 1600);
			}
		});
	});

	// the year, so nobody has to think about it again
	document.querySelectorAll('[data-year]').forEach(node => { node.textContent = String(new Date().getFullYear()); });

	if (!gsap || !ScrollTrigger || reduce) {
		revealEverything();
		return;
	}

	/* ---- motion ------------------------------------------------------------ */

	try {
		motionStarted = true;
		initMotion(gsap, ScrollTrigger);
	} catch (error) {
		console.warn('motion disabled:', error);
		revealEverything();
	}

	/** wraps each visual line of a heading so lines can slide up from behind a mask */
	function splitLines(element) {
		const words = element.innerHTML.trim().split(/\s+/);
		element.innerHTML = '';
		const probes = words.map((word, index) => {
			const span = document.createElement('span');
			span.style.display = 'inline-block';
			span.innerHTML = word;
			element.appendChild(span);
			if (index < words.length - 1) { element.appendChild(document.createTextNode(' ')); }
			return span;
		});
		const lines = [];
		let top = null;
		let current = [];
		probes.forEach(span => {
			if (top === null || Math.abs(span.offsetTop - top) < 4) {
				current.push(span);
				top = span.offsetTop;
			} else {
				lines.push(current);
				current = [span];
				top = span.offsetTop;
			}
		});
		if (current.length) { lines.push(current); }

		element.innerHTML = '';
		const lineNodes = lines.map(lineWords => {
			const line = document.createElement('span');
			line.style.display = 'block';
			lineWords.forEach((word, index) => {
				const span = document.createElement('span');
				span.style.display = 'inline-block';
				span.innerHTML = word.innerHTML;
				line.appendChild(span);
				if (index < lineWords.length - 1) { line.appendChild(document.createTextNode(' ')); }
			});
			element.appendChild(line);
			return line;
		});
		return { lines: lineNodes, words: element.querySelectorAll('span > span') };
	}

	function initMotion(gsap, ScrollTrigger) {

		const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

		/* hero ----------------------------------------------------------------- */

		const splitEl = document.querySelector('[data-split]');
		const split = splitEl ? splitLines(splitEl) : null;
		const heroTargets = gsap.utils.toArray('[data-hero]');
		gsap.set(heroTargets, { opacity: 0, y: 20 });
		if (split) {
			gsap.set(split.lines, { overflow: 'hidden', display: 'block' });
			gsap.set(split.words, { yPercent: 112 });
			gsap.set(splitEl, { y: 0 }); // the words carry the motion, the block only fades
		}

		const intro = gsap.timeline({ defaults: { ease: 'power3.out' }, delay: 0.1 });
		intro
			.fromTo('.nav', { opacity: 0, y: -14 }, { opacity: 1, y: 0, duration: 0.7, clearProps: 'opacity,transform' })
			.to('[data-hero="1"]', { opacity: 1, y: 0, duration: 0.6 }, 0.1)
			.to(split ? split.words : splitEl, { yPercent: 0, duration: 0.95, stagger: 0.04 }, 0.2)
			.to(splitEl, { opacity: 1, duration: 0.01 }, 0.2)
			.to('[data-hero="3"]', { opacity: 1, y: 0, duration: 0.7 }, 0.42)
			.to('[data-hero="4"]', { opacity: 1, y: 0, duration: 0.7 }, 0.54)
			.to('[data-hero="5"]', { opacity: 1, y: 0, duration: 0.7 }, 0.64)
			.to('[data-hero="6"]', { opacity: 1, y: 0, duration: 0.95 }, 0.32);

		// the mini terminal types itself once the window has landed
		const typed = document.querySelector('[data-typed]');
		const typedOut = document.querySelector('[data-typed-out]');
		const typedCaret = document.querySelector('.window-panel .caret');
		if (typed && typedOut) {
			const command = typed.textContent;
			typed.textContent = '';
			gsap.set(typedOut, { opacity: 0 });
			if (typedCaret) { gsap.set(typedCaret, { opacity: 0 }); }
			intro.call(() => {
				const state = { i: 0 };
				gsap.to(state, {
					i: command.length,
					duration: 1.05,
					ease: 'none',
					onUpdate: () => { typed.textContent = command.slice(0, Math.round(state.i)); },
					onComplete: () => {
						gsap.to(typedOut, { opacity: 1, duration: 0.35 });
						if (typedCaret) { gsap.to(typedCaret, { opacity: 0.999, duration: 0.2 }); }
					}
				});
			}, null, 1.1);
		}

		// hero parallax: the window drifts slower than the copy
		if (canHover) {
			gsap.to('[data-parallax]', {
				yPercent: 9,
				ease: 'none',
				scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true }
			});
		}

		// pointer glow in the hero
		const glow = document.querySelector('.cursor-glow');
		const hero = document.querySelector('.hero');
		if (glow && hero && canHover) {
			const moveX = gsap.quickTo(glow, 'left', { duration: 0.55, ease: 'power3' });
			const moveY = gsap.quickTo(glow, 'top', { duration: 0.55, ease: 'power3' });
			hero.addEventListener('pointermove', event => {
				const bounds = hero.getBoundingClientRect();
				glow.style.opacity = '1';
				moveX(event.clientX - bounds.left);
				moveY(event.clientY - bounds.top);
			});
			hero.addEventListener('pointerleave', () => { glow.style.opacity = '0'; });
		}

		// magnetic buttons (transform is owned by GSAP: the CSS never transitions transform)
		if (canHover) {
			document.querySelectorAll('.btn').forEach(button => {
				const xTo = gsap.quickTo(button, 'x', { duration: 0.4, ease: 'power3' });
				const yTo = gsap.quickTo(button, 'y', { duration: 0.4, ease: 'power3' });
				button.addEventListener('pointermove', event => {
					const bounds = button.getBoundingClientRect();
					xTo((event.clientX - bounds.left - bounds.width / 2) * 0.18);
					yTo((event.clientY - bounds.top - bounds.height / 2) * 0.28);
				});
				button.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
			});
		}

		/* marquee -------------------------------------------------------------- */

		const track = document.querySelector('[data-marquee]');
		if (track) {
			const clone = track.cloneNode(true);
			clone.setAttribute('aria-hidden', 'true');
			track.parentElement.appendChild(clone);
			track.parentElement.style.display = 'flex';
			gsap.set([track, clone], { flex: 'none' });
			gsap.to([track, clone], { xPercent: -100, ease: 'none', duration: 40, repeat: -1 });
		}

		/* scroll reveals -------------------------------------------------------- */

		gsap.utils.toArray('[data-reveal]').forEach((element, index) => {
			gsap.fromTo(element, { opacity: 0, y: 26 }, {
				opacity: 1,
				y: 0,
				duration: 0.85,
				ease: 'power3.out',
				delay: (index % 3) * 0.06,
				scrollTrigger: { trigger: element, start: 'top 88%' },
				onComplete: () => gsap.set(element, { clearProps: 'transform' })
			});
		});

		// counters
		gsap.utils.toArray('[data-count]').forEach(node => {
			const value = Number(node.getAttribute('data-count'));
			const state = { value: 0 };
			gsap.to(state, {
				value,
				duration: 1.4,
				ease: 'power2.out',
				scrollTrigger: { trigger: node, start: 'top 90%' },
				onUpdate: () => { node.textContent = String(Math.round(state.value)); }
			});
		});

		/* deep dives ------------------------------------------------------------ */

		// the terminal session types itself, line by line
		const terminalBody = document.querySelector('[data-terminal-typing] .terminal-body');
		if (terminalBody) {
			const lines = gsap.utils.toArray('[data-line]', terminalBody);
			gsap.set(lines, { opacity: 0 });
			const session = gsap.timeline({ scrollTrigger: { trigger: terminalBody, start: 'top 78%' } });
			lines.forEach(line => {
				const text = line.textContent;
				if (line.classList.contains('term-line') && text.trim().length > 0) {
					const typedSpan = document.createElement('span');
					line.textContent = '';
					line.appendChild(typedSpan);
					const state = { i: 0 };
					session
						.to(line, { opacity: 1, duration: 0.01 })
						.to(state, {
							i: text.length,
							duration: Math.max(0.35, text.length * 0.026),
							ease: 'none',
							onUpdate: () => { typedSpan.textContent = text.slice(0, Math.round(state.i)); }
						});
				} else {
					session.fromTo(line, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }, '<0.05');
				}
				session.to({}, { duration: 0.16 });
			});
		}

		// the squiggle draws itself, then the diagnostic card lands
		const squiggleLine = document.querySelector('.squiggle-line');
		const squiggle = document.querySelector('.squiggle');
		const diagCard = document.querySelector('[data-diag-card]');
		if (squiggleLine && squiggle && diagCard) {
			gsap.fromTo(squiggleLine, { scaleX: 0 }, {
				scaleX: 1,
				duration: 0.7,
				ease: 'power2.out',
				scrollTrigger: { trigger: squiggle, start: 'top 82%' }
			});
			gsap.fromTo(diagCard, { opacity: 0, y: 14 }, {
				opacity: 1,
				y: 0,
				duration: 0.6,
				ease: 'power3.out',
				delay: 0.4,
				scrollTrigger: { trigger: squiggle, start: 'top 82%' }
			});
		}

		/* architecture ----------------------------------------------------------- */

		const archBoxes = gsap.utils.toArray('[data-arch-box]');
		const archLines = gsap.utils.toArray('[data-arch-line]');
		if (archBoxes.length) {
			archLines.forEach(line => {
				const length = typeof line.getTotalLength === 'function' ? line.getTotalLength() : 320;
				gsap.set(line, { strokeDasharray: length, strokeDashoffset: length });
			});
			gsap.set(archBoxes, { opacity: 0, y: 18 });
			gsap.timeline({ scrollTrigger: { trigger: '.arch-wrap', start: 'top 78%' } })
				.to(archBoxes, { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power3.out' })
				.to(archLines, { strokeDashoffset: 0, duration: 0.9, stagger: 0.12, ease: 'power2.inOut' }, 0.35);
		}

		/* footer ghost word ------------------------------------------------------ */

		const ghost = document.querySelector('.footer-word');
		if (ghost) {
			gsap.fromTo(ghost, { yPercent: 34, opacity: 0 }, {
				yPercent: 0,
				opacity: 1,
				duration: 1.1,
				ease: 'power3.out',
				scrollTrigger: { trigger: '.footer', start: 'top 92%' }
			});
		}

		// re-measure once the webfont lands (line splitting depends on metrics)
		if (document.fonts && document.fonts.ready) {
			document.fonts.ready.then(() => ScrollTrigger.refresh());
		}
	}
})();
