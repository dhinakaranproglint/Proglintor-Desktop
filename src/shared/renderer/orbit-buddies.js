'use strict';
// Orbit's animal friends: small, hand-built vector characters that act out the reminders (an otter sips water, a red panda stretches,
// an owl rests its eyes, a sloth breathes). Pure inline SVG + CSS animation (see orbit.css, ".bd-*"): no images, no libraries, and they
// stop moving when the person prefers reduced motion. Loaded in the app windows and tested with require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrbitBuddies = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  let counter = 0;

  const ANIMALS = {
    otter: { name: 'Splash', does: 'sips water', label: 'An otter sipping water' },
    redpanda: { name: 'Rudy', does: 'stretches and says hello', label: 'A red panda stretching' },
    owl: { name: 'Hoot', does: 'rests his eyes with you', label: 'An owl resting its eyes' },
    sloth: { name: 'Slo', does: 'breathes slowly', label: 'A sloth taking it easy' },
  };

  /** Which friend (and which move) goes with each reminder or moment. */
  const FOR_REMINDER = {
    water: { animal: 'otter' }, eyes: { animal: 'owl' }, stretch: { animal: 'redpanda', mode: 'stretch' },
    rest: { animal: 'sloth' }, focusEnd: { animal: 'sloth' }, overwork: { animal: 'sloth' },
    meal: { animal: 'redpanda', mode: 'munch' }, wrapup: { animal: 'redpanda', mode: 'wave' },
  };
  const FOR_MOMENT = { greet: { animal: 'redpanda', mode: 'wave' }, welcome: { animal: 'redpanda', mode: 'wave' }, checkin: { animal: 'sloth' } };

  /** The move for an event: the red panda stretches, waves or munches; the others have one signature move. */
  const MODE_FOR_EVENT = { stretch: 'stretch', meal: 'munch', wrapup: 'wave', greet: 'wave', welcome: 'wave' };

  /** Which animal acts out `event` for this person (their own choice, else the default), and which move. null = none. */
  function resolve(event, persona) {
    const defaults = { ...Object.fromEntries(Object.entries(FOR_REMINDER).map(([k, v]) => [k, v.animal])), greet: 'redpanda', welcome: 'redpanda', checkin: 'sloth' };
    const chosen = (persona && persona.buddies && persona.buddies[event]) || defaults[event];
    if (!chosen || chosen === 'none' || !ANIMALS[chosen]) return null;
    return { animal: chosen, mode: chosen === 'redpanda' ? (MODE_FOR_EVENT[event] || '') : '' };
  }

  const forReminder = (kind) => FOR_REMINDER[kind] || null;
  const forMoment = (name) => FOR_MOMENT[name] || null;

  const eyes = (lx, rx, y, r = 3.3) => `<g class="bd-eyes">${[lx, rx].map((x) => `<g class="bd-eye"><circle cx="${x}" cy="${y}" r="${r}" fill="#2a1d17"/><circle cx="${x - 1}" cy="${y - 1.2}" r="1.1" fill="#fff"/></g>`).join('')}</g>`;

  function otter(u, color) {
    return `<defs><linearGradient id="${u}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c0906a"/><stop offset="1" stop-color="#8a5b38"/></linearGradient>
      <clipPath id="${u}g"><rect x="0" y="0" width="16" height="22" rx="3.5"/></clipPath></defs>
      <ellipse class="bd-shadow" cx="60" cy="113" rx="30" ry="5" fill="rgba(0,0,0,.18)"/>
      <path class="bd-tail" d="M36 98 Q8 108 14 84 Q20 96 38 92Z" fill="url(#${u}f)"/>
      <ellipse cx="60" cy="92" rx="30" ry="23" fill="url(#${u}f)"/><ellipse cx="60" cy="96" rx="17" ry="15" fill="#ecd6b8"/>
      <ellipse cx="45" cy="112" rx="9" ry="4.6" fill="#7a4f30"/><ellipse cx="75" cy="112" rx="9" ry="4.6" fill="#7a4f30"/>
      <ellipse cx="37" cy="90" rx="6" ry="12" fill="url(#${u}f)" transform="rotate(18 37 90)"/>
      <g class="bd-head">
        <circle cx="39" cy="31" r="6.5" fill="url(#${u}f)"/><circle cx="39" cy="31" r="3.2" fill="#e8bba2"/>
        <circle cx="81" cy="31" r="6.5" fill="url(#${u}f)"/><circle cx="81" cy="31" r="3.2" fill="#e8bba2"/>
        <circle cx="60" cy="50" r="26" fill="url(#${u}f)"/>
        <ellipse cx="60" cy="60" rx="16" ry="11" fill="#efdcc3"/>
        <ellipse cx="42" cy="56" rx="5" ry="3.4" fill="#ff8da1" opacity=".32"/><ellipse cx="78" cy="56" rx="5" ry="3.4" fill="#ff8da1" opacity=".32"/>
        ${eyes(49, 71, 46, 3.5)}
        <ellipse cx="60" cy="55" rx="5.4" ry="3.7" fill="#3b2a22"/><ellipse cx="58.6" cy="54" rx="1.6" ry=".9" fill="#fff" opacity=".6"/>
        <path d="M54.5 62.5 Q60 68 65.5 62.5" fill="none" stroke="#3b2a22" stroke-width="2" stroke-linecap="round"/>
        <g stroke="#3b2a22" stroke-width="1.1" stroke-linecap="round" opacity=".55"><path d="M40 59 L30 57"/><path d="M40 62 L30 64"/><path d="M80 59 L90 57"/><path d="M80 62 L90 64"/></g>
      </g>
      <g class="bd-sip">
        <ellipse cx="83" cy="86" rx="6" ry="12" fill="url(#${u}f)" transform="rotate(-20 83 86)"/>
        <g transform="translate(76 62)"><rect x="0" y="0" width="16" height="22" rx="3.5" fill="rgba(255,255,255,.32)" stroke="rgba(255,255,255,.85)" stroke-width="1.4"/>
          <g clip-path="url(#${u}g)"><rect class="bd-water" x="0" y="5" width="16" height="17" fill="${color}" opacity=".85"/></g>
          <path d="M3 3 L3 16" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".7"/></g>
      </g>
      <g class="bd-drops" fill="${color}"><circle class="bd-drop d1" cx="98" cy="50" r="2.2"/><circle class="bd-drop d2" cx="103" cy="58" r="1.6"/><circle class="bd-drop d3" cx="94" cy="42" r="1.4"/></g>`;
  }

  function redpanda(u) {
    return `<defs><linearGradient id="${u}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ee7e3c"/><stop offset="1" stop-color="#c3501c"/></linearGradient></defs>
      <ellipse class="bd-shadow" cx="60" cy="113" rx="30" ry="5" fill="rgba(0,0,0,.18)"/>
      <g class="bd-tail"><ellipse cx="94" cy="88" rx="12" ry="27" fill="url(#${u}f)" transform="rotate(24 94 88)"/>
        <path d="M86 70 Q102 74 103 84 M84 86 Q99 90 98 100" fill="none" stroke="rgba(70,28,10,.28)" stroke-width="4.5" stroke-linecap="round"/></g>
      <g class="bd-body">
        <ellipse cx="46" cy="110" rx="9" ry="5.5" fill="#3a2a24"/><ellipse cx="74" cy="110" rx="9" ry="5.5" fill="#3a2a24"/>
        <ellipse cx="60" cy="90" rx="25" ry="23" fill="url(#${u}f)"/><ellipse cx="60" cy="94" rx="15" ry="16" fill="#4a352c"/>
        <g class="bd-armL"><ellipse cx="42" cy="90" rx="5.6" ry="14" fill="#3a2a24"/></g>
        <g class="bd-armR"><ellipse cx="78" cy="90" rx="5.6" ry="14" fill="#3a2a24"/></g>
        <g class="bd-food"><circle cx="60" cy="84" r="8" fill="#e5484d"/><path d="M60 76 q4 -5 7 -3 q-2 4 -7 3z" fill="#4caf50"/><ellipse cx="57" cy="81" rx="2" ry="1.2" fill="#fff" opacity=".55"/></g>
      </g>
      <g class="bd-head">
        <circle cx="40" cy="29" r="9.5" fill="url(#${u}f)"/><circle cx="40" cy="30" r="5.3" fill="#fff4e6"/>
        <circle cx="80" cy="29" r="9.5" fill="url(#${u}f)"/><circle cx="80" cy="30" r="5.3" fill="#fff4e6"/>
        <circle cx="60" cy="48" r="25" fill="url(#${u}f)"/>
        <ellipse cx="44" cy="57" rx="9.5" ry="8" fill="#fff4e6"/><ellipse cx="76" cy="57" rx="9.5" ry="8" fill="#fff4e6"/>
        <ellipse cx="60" cy="60" rx="10" ry="8" fill="#fff9f1"/>
        <ellipse cx="50" cy="37" rx="3.4" ry="2" fill="#fff4e6"/><ellipse cx="70" cy="37" rx="3.4" ry="2" fill="#fff4e6"/>
        <path d="M49 51 Q47.5 57 50.5 61 M71 51 Q72.5 57 69.5 61" fill="none" stroke="#b6431a" stroke-width="2.4" stroke-linecap="round" opacity=".85"/>
        ${eyes(50, 70, 47.5, 3.4)}
        <ellipse cx="60" cy="57.5" rx="4.6" ry="3.2" fill="#2a1d17"/>
        <path class="bd-mouth" d="M55 63 Q60 67.5 65 63" fill="none" stroke="#3b2a22" stroke-width="1.9" stroke-linecap="round"/>
      </g>`;
  }

  function owl(u) {
    return `<defs><linearGradient id="${u}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a7a5c"/><stop offset="1" stop-color="#6b523c"/></linearGradient></defs>
      <ellipse class="bd-shadow" cx="60" cy="113" rx="28" ry="5" fill="rgba(0,0,0,.18)"/>
      <g class="bd-body"><ellipse cx="60" cy="72" rx="35" ry="40" fill="url(#${u}f)"/>
        <ellipse cx="60" cy="84" rx="22" ry="27" fill="#eadbc3"/>
        <g fill="none" stroke="#c9b394" stroke-width="2" stroke-linecap="round"><path d="M50 78 q4 4 8 0 M62 78 q4 4 8 0 M44 90 q4 4 8 0 M56 90 q4 4 8 0 M68 90 q4 4 8 0 M50 102 q4 4 8 0 M62 102 q4 4 8 0"/></g>
        <ellipse class="bd-wingL" cx="29" cy="78" rx="9" ry="22" fill="#5d4633" transform="rotate(10 29 78)"/><ellipse class="bd-wingR" cx="91" cy="78" rx="9" ry="22" fill="#5d4633" transform="rotate(-10 91 78)"/>
        <ellipse cx="48" cy="112" rx="8" ry="4" fill="#f0a23b"/><ellipse cx="72" cy="112" rx="8" ry="4" fill="#f0a23b"/></g>
      <g class="bd-head">
        <path d="M30 34 L36 12 L50 28Z" fill="#6b523c"/><path d="M90 34 L84 12 L70 28Z" fill="#6b523c"/>
        <ellipse cx="60" cy="46" rx="34" ry="29" fill="url(#${u}f)"/>
        <circle cx="45" cy="47" r="16" fill="#fff6e6" stroke="#f0a23b" stroke-width="2.5"/><circle cx="75" cy="47" r="16" fill="#fff6e6" stroke="#f0a23b" stroke-width="2.5"/>
        <g class="bd-gaze"><circle cx="45" cy="47" r="7.8" fill="#2a1d17"/><circle cx="42.4" cy="44" r="2.5" fill="#fff"/><circle cx="75" cy="47" r="7.8" fill="#2a1d17"/><circle cx="72.4" cy="44" r="2.5" fill="#fff"/></g>
        <g class="bd-lids" fill="url(#${u}f)"><ellipse class="bd-lid" cx="45" cy="47" rx="16.5" ry="16.5"/><ellipse class="bd-lid" cx="75" cy="47" rx="16.5" ry="16.5"/></g>
        <path d="M60 50 L54 60 L60 68 L66 60Z" fill="#f0a23b"/><path d="M60 50 L54 60 L66 60Z" fill="#ffc062"/>
      </g>`;
  }

  function sloth(u) {
    return `<defs><linearGradient id="${u}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9a982"/><stop offset="1" stop-color="#9c7a58"/></linearGradient></defs>
      <ellipse class="bd-shadow" cx="60" cy="113" rx="32" ry="5" fill="rgba(0,0,0,.18)"/>
      <g class="bd-breathe">
        <ellipse cx="46" cy="110" rx="9" ry="5" fill="#7a5c41"/><ellipse cx="74" cy="110" rx="9" ry="5" fill="#7a5c41"/>
        <ellipse cx="60" cy="90" rx="30" ry="24" fill="url(#${u}f)"/><ellipse cx="60" cy="95" rx="18" ry="16" fill="#e6d3b6"/>
        <path d="M34 84 Q26 104 44 106" fill="none" stroke="#9c7a58" stroke-width="9" stroke-linecap="round"/><path d="M86 84 Q94 104 76 106" fill="none" stroke="#9c7a58" stroke-width="9" stroke-linecap="round"/>
        <g fill="#6a4d36"><path d="M40 106 l-3 6 l4 -2z M46 108 l-1 6 l4 -3z"/><path d="M80 106 l3 6 l-4 -2z M74 108 l1 6 l-4 -3z"/></g>
      </g>
      <g class="bd-head">
        <circle cx="60" cy="50" r="27" fill="url(#${u}f)"/><ellipse cx="60" cy="56" rx="19" ry="16" fill="#efe0c8"/>
        <ellipse cx="47" cy="47" rx="9" ry="6.5" fill="#5a4030" transform="rotate(-22 47 47)"/><ellipse cx="73" cy="47" rx="9" ry="6.5" fill="#5a4030" transform="rotate(22 73 47)"/>
        <g class="bd-sleepy" fill="none" stroke="#f6ead4" stroke-width="2.2" stroke-linecap="round"><path d="M44 48 Q47 51 50 48"/><path d="M70 48 Q73 51 76 48"/></g>
        <ellipse cx="60" cy="56" rx="4.6" ry="3.2" fill="#3b2a22"/>
        <path d="M54 62 Q60 67.5 66 62" fill="none" stroke="#3b2a22" stroke-width="2" stroke-linecap="round"/>
        <ellipse cx="40" cy="58" rx="4.6" ry="3" fill="#ff8da1" opacity=".38"/><ellipse cx="80" cy="58" rx="4.6" ry="3" fill="#ff8da1" opacity=".38"/>
      </g>
      <g class="bd-zzz" fill="#8a93a5" font-family="-apple-system,Segoe UI,sans-serif" font-weight="700"><text class="z1" x="86" y="30" font-size="11">z</text><text class="z2" x="94" y="20" font-size="8">z</text></g>`;
  }

  const DRAW = { otter, redpanda, owl, sloth };

  /**
   * One friend as an inline SVG string. `mode` picks the move (redpanda: stretch | wave | munch). `color` tints accessories (the glass of water).
   * Every instance gets its own gradient ids, so several on one page never interfere.
   */
  function svg(animal, { mode = '', color = '#7C5CFF', size = 84 } = {}) {
    const a = ANIMALS[animal];
    if (!a) return '';
    counter += 1;
    const safeColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#7C5CFF';
    const px = Math.max(32, Math.min(200, Math.round(size)));
    const m = ['stretch', 'wave', 'munch'].includes(mode) ? mode : '';
    return `<svg class="bd bd-${animal}" data-mode="${m}" width="${px}" height="${px}" viewBox="0 0 120 120" role="img" aria-label="${a.label}" focusable="false">${DRAW[animal](`bd${counter}`, safeColor)}</svg>`;
  }

  return { ANIMALS, resolve, forReminder, forMoment, svg };
}));
