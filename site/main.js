// site/main.js — interactions + the GSAP layer.
//
// Progressive by construction: hidden states are applied here (never by CSS alone), GSAP is
// optional, prefers-reduced-motion renders the finished page, and a watchdog un-hides everything
// if motion never starts. Every interaction (nav, menu, copy) works without GSAP at all.

(() => {
	'use strict';

	const root = document.documentElement;

	// A landing page opens at the top. Browser scroll restoration fights the scroll-trigger
	// measurements (positions get computed against a half-restored scroll — the pan then paints
	// from the wrong offset), and a reload is a fresh visit here.
	if ('scrollRestoration' in history) {
		history.scrollRestoration = 'manual';
	}

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
	window.setTimeout(() => { if (!motionStarted) { revealEverything(); } }, 3500);

	/* ---- interactions (no GSAP required) ---------------------------------- */

	const nav = document.querySelector('.nav');
	const onScroll = () => nav && nav.classList.toggle('is-scrolled', window.scrollY > 8);
	onScroll();
	window.addEventListener('scroll', onScroll, { passive: true });

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

	// card spotlights (CSS variables, pointer only)
	if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
		document.querySelectorAll('.card').forEach(card => {
			card.addEventListener('pointermove', event => {
				const bounds = card.getBoundingClientRect();
				card.style.setProperty('--mx', `${event.clientX - bounds.left}px`);
				card.style.setProperty('--my', `${event.clientY - bounds.top}px`);
			});
		});
	}

	// the section rail highlights what is on screen
	if ('IntersectionObserver' in window) {
		const railLinks = new Map([...document.querySelectorAll('[data-rail]')].map(link => [link.getAttribute('data-rail'), link]));
		const observer = new IntersectionObserver(entries => {
			entries.filter(entry => entry.isIntersecting).forEach(entry => {
				railLinks.forEach(link => link.classList.remove('is-active'));
				railLinks.get(entry.target.id)?.classList.add('is-active');
			});
		}, { rootMargin: '-45% 0px -45% 0px' });
		railLinks.forEach((_, id) => { const section = document.getElementById(id); if (section) { observer.observe(section); } });
	}

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

	function initMotion(gsap, ScrollTrigger) {
		const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

		/* scroll progress hairline ---------------------------------------------- */
		gsap.to('.progress i', { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: 0.3 } });

		/* hero ------------------------------------------------------------------- */
		const heroTargets = gsap.utils.toArray('[data-hero]');
		gsap.set(heroTargets, { opacity: 0, y: 22 });
		const words = gsap.utils.toArray('.h-word');
		gsap.set(words, { yPercent: 114 });

		const intro = gsap.timeline({ defaults: { ease: 'power3.out' }, delay: 0.1 });
		intro
			.fromTo('.nav', { opacity: 0, y: -16 }, { opacity: 1, y: 0, duration: 0.7, clearProps: 'opacity,transform' })
			.to('[data-hero="1"]', { opacity: 1, y: 0, duration: 0.6 }, 0.15)
			.to(words, { yPercent: 0, duration: 1.05, stagger: 0.09 }, 0.22)
			.to('[data-hero="2"]', { opacity: 1, duration: 0.01 }, 0.22)
			.to('[data-hero="3"]', { opacity: 1, y: 0, duration: 0.7 }, 0.52)
			.to('[data-hero="4"]', { opacity: 1, y: 0, duration: 0.7 }, 0.64)
			.to('[data-hero="5"]', { opacity: 1, y: 0, duration: 0.7 }, 0.74)
			.to('[data-hero="6"]', { opacity: 1, y: 0, duration: 1.0 }, 0.4);

		// the mini terminal types itself
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
					i: command.length, duration: 1.0, ease: 'none',
					onUpdate: () => { typed.textContent = command.slice(0, Math.round(state.i)); },
					onComplete: () => {
						gsap.to(typedOut, { opacity: 1, duration: 0.35 });
						if (typedCaret) { gsap.to(typedCaret, { opacity: 0.999, duration: 0.2 }); }
					}
				});
			}, null, 1.2);
		}

		if (canHover) {
			// the window drifts slower than the copy
			gsap.to('[data-parallax]', {
				yPercent: 8, ease: 'none',
				scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true }
			});

			// a pointer-driven tilt on the window
			const tilt = document.querySelector('[data-tilt]');
			if (tilt) {
				const rotX = gsap.quickTo(tilt, 'rotationX', { duration: 0.7, ease: 'power3' });
				const rotY = gsap.quickTo(tilt, 'rotationY', { duration: 0.7, ease: 'power3' });
				document.querySelector('.hero')?.addEventListener('pointermove', event => {
					const nx = (event.clientX / window.innerWidth - 0.5) * 2;
					const ny = (event.clientY / window.innerHeight - 0.5) * 2;
					rotY(nx * 6);
					rotX(-ny * 4);
				});
				document.querySelector('.hero')?.addEventListener('pointerleave', () => { rotX(0); rotY(0); });
			}

			// the pointer glow
			const glow = document.querySelector('.cursor-glow');
			const hero = document.querySelector('.hero');
			if (glow && hero) {
				const moveX = gsap.quickTo(glow, 'left', { duration: 0.6, ease: 'power3' });
				const moveY = gsap.quickTo(glow, 'top', { duration: 0.6, ease: 'power3' });
				hero.addEventListener('pointermove', event => {
					const bounds = hero.getBoundingClientRect();
					glow.style.opacity = '1';
					moveX(event.clientX - bounds.left);
					moveY(event.clientY - bounds.top);
				});
				hero.addEventListener('pointerleave', () => { glow.style.opacity = '0'; });
			}

			// magnetic buttons
			document.querySelectorAll('.btn').forEach(button => {
				const xTo = gsap.quickTo(button, 'x', { duration: 0.4, ease: 'power3' });
				const yTo = gsap.quickTo(button, 'y', { duration: 0.4, ease: 'power3' });
				button.addEventListener('pointermove', event => {
					const bounds = button.getBoundingClientRect();
					xTo((event.clientX - bounds.left - bounds.width / 2) * 0.16);
					yTo((event.clientY - bounds.top - bounds.height / 2) * 0.26);
				});
				button.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
			});
		}

		/* ticker: two tracks, opposite directions --------------------------------- */
		gsap.utils.toArray('[data-ticker]').forEach(track => {
			const clone = track.cloneNode(true);
			clone.setAttribute('aria-hidden', 'true');
			track.parentElement.appendChild(clone);
			track.parentElement.style.display = 'flex';
			gsap.set([track, clone], { flex: 'none' });
			const direction = track.getAttribute('data-dir') === '-1' ? -1 : 1;
			gsap.fromTo([track, clone], { xPercent: direction > 0 ? 0 : -100 }, {
				xPercent: direction > 0 ? -100 : 0, ease: 'none', duration: 34, repeat: -1
			});
		});

		/* counters ------------------------------------------------------------------ */
		gsap.utils.toArray('[data-count]').forEach(node => {
			const value = Number(node.getAttribute('data-count'));
			const state = { value: 0 };
			gsap.to(state, {
				value, duration: 1.5, ease: 'power2.out',
				scrollTrigger: { trigger: node, start: 'top 92%' },
				onUpdate: () => { node.textContent = String(Math.round(state.value)); }
			});
		});

		/* capabilities: pinned horizontal rail (desktop only) ------------------------ */
		const setRailHidden = hidden => document.documentElement.classList.toggle('rail-hidden', hidden);
		const media = gsap.matchMedia();
		media.add('(min-width: 901px)', () => {
			const section = document.querySelector('.horizon');
			const track = document.querySelector('[data-horizon]');
			const bar = document.querySelector('[data-horizon-progress]');
			if (!section || !track) { return; }

			const distance = () => Math.max(0, track.scrollWidth - document.documentElement.clientWidth);
			// the sticky stage is one viewport tall; the section carries the extra scroll room
			const applyHeight = () => {
				section.style.height = '';
				section.style.height = `${section.offsetHeight + distance()}px`;
			};
			applyHeight();

			const tween = gsap.to(track, {
				x: () => -distance(),
				ease: 'none',
				scrollTrigger: {
					trigger: section,
					start: 'top top',
					end: 'bottom bottom',
					scrub: 1,
					invalidateOnRefresh: true,
					// cards pan across the whole viewport here: move the fixed rail out of their way
					onUpdate: self => {
						if (bar) { bar.style.transform = `scaleX(${self.progress})`; }
						setRailHidden(self.isActive);
					},
					onEnter: () => setRailHidden(true),
					onEnterBack: () => setRailHidden(true),
					onLeave: () => setRailHidden(false),
					onLeaveBack: () => setRailHidden(false)
				}
			});

			let resizeTimer;
			const onResize = () => {
				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => { applyHeight(); ScrollTrigger.refresh(); }, 180);
			};
			window.addEventListener('resize', onResize);

			return () => {
				window.removeEventListener('resize', onResize);
				clearTimeout(resizeTimer);
				tween.scrollTrigger?.kill();
				section.style.height = '';
				ScrollTrigger.refresh();
			};
		});

		/* sessions: the stack settles as the next card covers it ---------------------- */
		const cards = gsap.utils.toArray('[data-stack-card]');
		cards.forEach((card, index) => {
			gsap.set(card, { transformOrigin: 'center top' });
			if (index === cards.length - 1) { return; }
			gsap.to(card, {
				scale: 0.94, opacity: 0.5, ease: 'none',
				scrollTrigger: { trigger: cards[index + 1], start: 'top bottom', end: 'top 30%', scrub: true }
			});
		});

		/* scroll reveals (everything outside the pinned/stacked regions) --------------- */
		gsap.utils.toArray('[data-reveal]').forEach((element, index) => {
			gsap.fromTo(element, { opacity: 0, y: 28 }, {
				opacity: 1, y: 0, duration: 0.9, ease: 'power3.out',
				delay: (index % 3) * 0.05,
				scrollTrigger: { trigger: element, start: 'top 88%' },
				onComplete: () => gsap.set(element, { clearProps: 'transform' })
			});
		});

		/* the terminal session types itself -------------------------------------------- */
		const terminalBody = document.querySelector('[data-terminal-typing] .terminal-body');
		if (terminalBody) {
			const lines = gsap.utils.toArray('[data-line]', terminalBody);
			gsap.set(lines, { opacity: 0 });
			const session = gsap.timeline({ scrollTrigger: { trigger: terminalBody, start: 'top 80%' } });
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
							i: text.length, duration: Math.max(0.35, text.length * 0.026), ease: 'none',
							onUpdate: () => { typedSpan.textContent = text.slice(0, Math.round(state.i)); }
						});
				} else {
					session.fromTo(line, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }, '<0.05');
				}
				session.to({}, { duration: 0.16 });
			});
		}

		/* the squiggle draws, then the diagnostic card lands ----------------------------- */
		const squiggleLine = document.querySelector('.squiggle-line');
		const squiggle = document.querySelector('.squiggle');
		const diagCard = document.querySelector('[data-diag-card]');
		if (squiggleLine && squiggle && diagCard) {
			gsap.fromTo(squiggleLine, { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: 'power2.out', scrollTrigger: { trigger: squiggle, start: 'top 84%' } });
			gsap.fromTo(diagCard, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out', delay: 0.4, scrollTrigger: { trigger: squiggle, start: 'top 84%' } });
		}

		/* architecture: draw the lines, then run signal pulses along the ports ------------ */
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
				.to(archLines, { strokeDashoffset: 0, duration: 0.9, stagger: 0.1, ease: 'power2.inOut' }, 0.35);

			// travelling pulses: a dot walks each MessagePort route, forever
			const svg = document.querySelector('.arch');
			const pulses = gsap.utils.toArray('[data-arch-pulse]').map((path, index) => {
				const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
				dot.setAttribute('r', '4');
				dot.setAttribute('class', 'arch-pulse');
				svg.appendChild(dot);
				const length = path.getTotalLength();
				const state = { t: 0 };
				const tween = gsap.to(state, {
					t: 1, duration: 3.4, ease: 'none', repeat: -1, delay: index * 1.1, paused: true,
					onUpdate: () => {
						const point = path.getPointAtLength(state.t * length);
						dot.setAttribute('cx', point.x);
						dot.setAttribute('cy', point.y);
					}
				});
				return tween;
			});
			ScrollTrigger.create({
				trigger: '.arch-wrap', start: 'top 80%', end: 'bottom top',
				onEnter: () => pulses.forEach(tween => tween.play()),
				onEnterBack: () => pulses.forEach(tween => tween.play()),
				onLeave: () => pulses.forEach(tween => tween.pause()),
				onLeaveBack: () => pulses.forEach(tween => tween.pause())
			});
		}

		/* the footer word ------------------------------------------------------------- */
		const ghost = document.querySelector('.footer-word');
		if (ghost) {
			gsap.fromTo(ghost, { yPercent: 34, opacity: 0 }, {
				yPercent: 0, opacity: 1, duration: 1.1, ease: 'power3.out',
				scrollTrigger: { trigger: '.footer', start: 'top 92%' }
			});
		}

		// keep trigger positions honest: fonts, a restored scroll position, and bfcache restores
		// all land AFTER the first measurement — re-sync a few times, then once more on load
		const resync = () => ScrollTrigger.refresh();
		[150, 700, 1600].forEach(delay => window.setTimeout(resync, delay));
		window.addEventListener('load', () => window.setTimeout(resync, 80));
		window.addEventListener('pageshow', event => { if (event.persisted) { resync(); } });
		if (document.fonts && document.fonts.ready) {
			document.fonts.ready.then(resync);
		}
	}
})();
