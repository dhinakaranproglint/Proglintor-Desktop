'use strict';
// Install-assistant conversation logic: guardrails, intent planning and plain-language copy.
// Loaded as a plain script in the renderer (global `ChatLogic`) and with require() in tests.
// Deterministic by design: no model decides what gets installed, the server matches the approved catalogue.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatLogic = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const NAME = 'Proglintor';
  const MAX_LEN = 400;

  // ---- guardrails (input -> action -> output) ------------------------------------------------------

  const INJECTION = /\b(ignore\s+(all\s+)?(previous|prior|above)\s+instructions?|disregard\s+(all\s+)?(previous|prior)|system\s+prompt|you\s+are\s+now\s+dan|jailbreak|developer\s+mode|bypass\s+(policy|security|approval|guardrails?)|reveal\s+(your\s+)?(system|hidden)\s+prompt|pretend\s+you\s+have\s+no\s+restrictions|skip\s+(the\s+)?approval)\b/i;
  const OFF_TOPIC = /\b(source\s+code|write\s+(me\s+)?(a\s+)?(python|java|rust|go|sql|script|essay|poem|email)|generate\s+code|leetcode|homework|crypto\s+wallet|private\s+key|password\s+hash|hack\s+into|exploit|ransomware|malware\s+sample|politics|who\s+won\s+the\s+(election|match))\b/i;
  const CONTINUE = /^(continue|go\s+on|proceed|retry|try\s+again|do\s+it|do\s+that|yes|yep|yeah|sure|please\s+continue|go\s+ahead|same\s+again|again)[\s!.?]*$/i;

  function hasUnsafeControls(text) {
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c === 127 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) return true;
    }
    return false;
  }

  /** -> { ok: true, text } | { ok: false, reason, message } */
  function guardInput(raw, maxLen = MAX_LEN) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, reason: 'empty', message: 'Type what you would like to install, for example “Install Git”.' };
    if (text.length > maxLen) return { ok: false, reason: 'too_long', message: `That's a bit long for me — please keep it under ${maxLen} characters, like “Install Slack”.` };
    if (hasUnsafeControls(text)) return { ok: false, reason: 'control_chars', message: "That message has characters I can't safely read. Please type it again in plain text." };
    if (INJECTION.test(text)) {
      return { ok: false, reason: 'injection', message: `I can't do that. Approvals and security checks can't be skipped, and I only install software from your company's approved list. Tell me which app you need and I'll request it.` };
    }
    if (OFF_TOPIC.test(text)) {
      return { ok: false, reason: 'off_topic', message: `I'm ${NAME}'s install assistant, so I can only help with installing approved software on this computer. For anything else, please contact IT.` };
    }
    return { ok: true, text };
  }

  const isContinuePhrase = (t) => CONTINUE.test(String(t).trim());

  /** Never echo secret-shaped strings in assistant prose. */
  function guardOutputText(text) {
    return String(text ?? '')
      .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[hidden]')
      .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, '[hidden]');
  }

  // ---- understanding a turn -------------------------------------------------------------------------

  const GREETING = /^(hi|hello|hey|howdy|yo|sup|good\s+(morning|afternoon|evening))\b/i;
  const IDENTITY = /^(who\s+are\s+you|what\s+are\s+you|what('?s| is)\s+your\s+name|your\s+name\??)/i;
  const HELP = /^(help|help\s+me|what\s+can\s+you\s+do|how\s+do\s+(you|i)\s+work|how\s+does\s+(this|it)\s+work)[\s!.?]*$/i;
  const THANKS = /^(thanks|thank\s+you|thx|ok|okay|cool|great|nice|perfect|got\s+it)[\s!.?]*$/i;
  const INSTALL_VERB = /\b(install|get|add|setup|set\s+up|download|provision|deploy|update|upgrade|reinstall)\b/i;
  const STATUS = /^(status|progress|what('?s| is)\s+(the\s+)?(status|progress)|how('?s| is)\s+(it|that|my|the)\b|any\s+update|is\s+it\s+(done|ready|installed)|where('?s| is)\s+my)/i;
  const CANCEL = /^(cancel|abort|never\s*mind|forget\s+it|stop)\b/i;
  const UNINSTALL = /^(please\s+)?(un-?install|remove|delete)\b/i;
  const CATALOGUE = /(\b(what|which)\b.*\b(can|could|may)\b.*\b(install|get|request)\b)|(\b(list|show)\b.*\b(software|apps|applications|catalogue|catalog|available)\b)|^(catalogue|catalog|software|apps|available( software| apps)?)[\s?.!]*$/i;

  function classifyTurn(raw) {
    const text = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!text) return { kind: 'unclear' };
    if (IDENTITY.test(text)) return { kind: 'identity' };
    if (HELP.test(text)) return { kind: 'help' };
    if (THANKS.test(text)) return { kind: 'thanks' };
    if (CANCEL.test(text)) return { kind: 'cancel' };
    if (STATUS.test(text)) return { kind: 'status' };
    if (UNINSTALL.test(text)) return { kind: 'uninstall' };
    if (CATALOGUE.test(text)) return { kind: 'catalogue' };
    if (GREETING.test(text) && !INSTALL_VERB.test(text)) return { kind: 'greeting' };
    if (INSTALL_VERB.test(text) || /^[a-z0-9][\w .+#-]{0,80}$/i.test(text)) return { kind: 'install', query: text };
    return { kind: 'unclear' };
  }

  const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || 'there';

  function welcome(employeeName) {
    return `Hi ${firstName(employeeName)}, I'm ${NAME}. I can install approved software on this computer for you.\n\n` +
      'Tell me what you need, for example “Install Slack”. If it needs an admin’s OK, I’ll ask for it and finish the install as soon as it’s approved.';
  }

  const REPLIES = {
    greeting: () => `Hi! I'm ${NAME}, your install assistant. Which app would you like on this computer?`,
    identity: () => `I'm ${NAME}'s install assistant. I request and install software from your company's approved list on this computer — and I keep you posted until it's done.`,
    help: () => 'Here’s what I can do:\n• Install approved apps, e.g. “Install Git”\n• Ask your admin for approval when it’s needed\n• Show what’s available — say “what can I install?”\n• Check progress — say “status”\n• Cancel a request that hasn’t started — say “cancel”\n\nAfter a problem, “try again” repeats your last request.',
    thanks: () => "You're welcome! Tell me whenever you need another app.",
    unclear: () => `I'm ${NAME}, and I help with installing approved software. Which app would you like?`,
    uninstall: () => "I can only install software. To remove an app, please ask your IT admin.",
  };

  const WANTS = /\b(need|want|looking\s+for|require|would\s+like)\b/i;
  /** Keeps the employee's own words when they already say what they want; only a bare name gets "Install" in front. */
  const YES = /^(yes|yep|yeah|yup|y|sure|ok|okay|please|correct|right|that'?s (it|right|correct)|go ahead|do it|install it)[\s!.,]*$/i;
  const NO = /^(no|nope|nah|not that|wrong|neither|none)[\s!.,]*$/i;
  /** Kinds answered by the model when it is available (the canned text is the fallback). */
  const CONVERSATIONAL = new Set(['greeting', 'identity', 'thanks', 'unclear', 'uninstall']);

  const normalizeInstallPrompt = (text) => (INSTALL_VERB.test(text) || WANTS.test(text) ? text : `Install ${text}`);

  /**
   * Decides what to do with a message.
   * @param {string} raw
   * @param {{lastInstallPrompt:string|null,lastStatus:string|null,lastReason:string|null}} ctx
   * @returns {{kind:'reply',text:string}|{kind:'install',prompt:string,resumeNote?:string}|{kind:'cancel'}|{kind:'status'}|{kind:'catalogue'}}
   */
  function planTurn(raw, ctx) {
    const gated = guardInput(raw);
    if (!gated.ok) return { kind: 'reply', text: guardOutputText(gated.message), blocked: gated.reason };
    const text = gated.text;

    // "Shall I ask IT to review this app?" was asked: yes sends it, no drops it.
    if (ctx.pendingProposal) {
      if (YES.test(text)) return { kind: 'confirmProposal', id: ctx.pendingProposal };
      if (NO.test(text)) return { kind: 'dropProposal', id: ctx.pendingProposal };
    }

    // "Did you mean Slack?" was asked: yes requests exactly that name, no lets them try again.
    if (ctx.pendingSuggestion) {
      if (YES.test(text)) return { kind: 'install', prompt: `Install ${ctx.pendingSuggestion}` };
      if (NO.test(text)) return { kind: 'reply', text: "No problem. Tell me the exact app name, or say “what can I install?” to see what's available." };
    }

    if (isContinuePhrase(text)) {
      if (!ctx.lastInstallPrompt) return { kind: 'reply', text: 'Sure — which app would you like me to install? For example “Install Git”.' };
      if (ctx.lastStatus === 'NOT_FOUND') {
        return { kind: 'reply', text: `I already checked the approved list for “${ctx.lastInstallPrompt}” and it isn't there. Try another name, or ask your admin to add it.` };
      }
      if (ctx.lastStatus === 'ALREADY_INSTALLED') {
        return { kind: 'reply', text: `That one is already installed here. Tell me another app if you need something else.` };
      }
      if (ctx.lastStatus === 'REJECTED') {
        return { kind: 'reply', text: 'Your admin declined that request. If you still need it, talk to them first — then I can ask again.' };
      }
      if (ctx.lastStatus === 'INCOMPATIBLE') {
        return { kind: 'reply', text: "That app isn't available for this computer, so retrying won't help. Ask IT if there's an alternative." };
      }
      return { kind: 'install', prompt: ctx.lastInstallPrompt, resumeNote: `Trying again: “${ctx.lastInstallPrompt}”.` };
    }

    const turn = classifyTurn(text);
    if (turn.kind === 'install') return { kind: 'install', prompt: normalizeInstallPrompt(turn.query) };
    if (turn.kind === 'cancel' || turn.kind === 'status' || turn.kind === 'catalogue') return { kind: turn.kind };
    return { kind: 'reply', text: guardOutputText((REPLIES[turn.kind] || REPLIES.unclear)()), llm: CONVERSATIONAL.has(turn.kind) };
  }

  /** "reinstall Slack", "install Slack again", "repair Slack": the employee knows it may already be there and wants it done anyway. */
  const wantsReinstall = (text) => /\b(re-?install|repair|again)\b/i.test(String(text || ''));

  const nextContext = (installPrompt, status, reason) => ({ lastInstallPrompt: installPrompt, lastStatus: status, lastReason: reason || null });

  // ---- what the assistant says about each outcome -------------------------------------------------------

  const FAILURE = {
    APP_IN_USE: { text: 'The app is open right now. Quit it, then say “try again”.', retry: true },
    NEWER_VERSION_INSTALLED: { text: "This computer already has a newer version than the approved one, so I left it alone — you're up to date.", retry: false },
    DOWNGRADE_REFUSED: { text: 'This computer already has a newer version, so nothing was changed.', retry: false },
    DESTINATION_CONFLICT: { text: 'A different app with the same name is already in Applications. IT needs to sort that out first.', retry: false, escalate: true },
    DESTINATION_NOT_WRITABLE: { text: "I couldn't write to the Applications folder with your account. Ask IT to install it for you.", retry: false, escalate: true },
    TEAM_ID_MISMATCH: { text: "The download wasn't signed by the expected company, so I blocked it. IT has been notified through the log.", retry: false, escalate: true },
    SIGNATURE_INVALID: { text: "The app's digital signature didn't check out, so I blocked it for your safety.", retry: false, escalate: true },
    GATEKEEPER_REJECTED: { text: "macOS didn't trust this app, so I stopped. Please contact IT.", retry: false, escalate: true },
    BUNDLE_ID_MISMATCH: { text: 'The download contained a different app than the one approved, so I stopped.', retry: false, escalate: true },
    VERSION_MISMATCH: { text: 'The download had a different version than the one approved, so I stopped.', retry: false, escalate: true },
    SYMLINK_REJECTED: { text: 'The download contained unsafe file links, so I blocked it.', retry: false, escalate: true },
    ZIP_PATH_REJECTED: { text: 'The download contained unsafe file paths, so I blocked it.', retry: false, escalate: true },
    DIGEST_MISMATCH: { text: "The downloaded file didn't match the approved one, so I deleted it. Please tell IT.", retry: false, escalate: true },
    DOWNLOAD_FAILED: { text: "The download didn't finish. Check your internet connection, then say “try again”.", retry: true },
    INSUFFICIENT_DISK: { text: 'This computer needs more free disk space for the install. Free some up, then say “try again”.', retry: true },
    INSTALLER_TIMEOUT: { text: 'The installer took too long and was stopped. Say “try again”.', retry: true },
    INSTALL_INTERRUPTED: { text: 'The install was interrupted (Proglintor or the computer stopped). Say “try again”.', retry: true },
    INSTALL_FAILED: { text: "The installer reported a problem. Say “try again”, and if it happens again let IT know.", retry: true, escalate: true },
    NOT_DETECTED_AFTER_INSTALL: { text: "The installer finished, but I couldn't find the app afterwards. Say “try again”, or ask IT.", retry: true, escalate: true },
    DMG_LICENSE_PROMPT: { text: 'This download asks you to accept a licence by hand, which I can’t do. IT can repackage it.', retry: false, escalate: true },
    DMG_ATTACH_FAILED: { text: "The disk image couldn't be opened. Say “try again”, or ask IT.", retry: true },
    PAYLOAD_NOT_FOUND: { text: "The app wasn't where the approved download said it would be. Please tell IT.", retry: false, escalate: true },
    INSTALLER_UNSUPPORTED: { text: "This computer can't install that kind of package yet. Please ask IT.", retry: false, escalate: true },
    ELEVATION_DENIED: { text: 'This install needs a Mac administrator. Say “try again”, and when macOS asks, enter an administrator’s name and password. If you’re not an administrator, ask IT to enter theirs or to install it for you.', retry: true },
    ELEVATION_REQUIRED: { text: 'This install needs administrator rights your account doesn’t have. Please ask IT.', retry: false, escalate: true },
    ITEM_WITHDRAWN: { text: 'IT removed this app from the approved list before it could be installed.', retry: false },
    CATALOGUE_CHANGED: { text: 'The approved installer was updated after your request, so I stopped to stay safe. Say “try again” to request the new version.', retry: true },
    APPROVAL_TIMEOUT: { text: 'Nobody reviewed this request in time, so it expired. Say “try again” if you still need it.', retry: true },
    DEVICE_OFFLINE: { text: "This computer didn't pick the install up in time, so it expired. Keep Proglintor running and say “try again”.", retry: true },
    PLATFORM_MISMATCH: { text: "That app isn't available for this operating system.", retry: false },
    ARCH_MISMATCH: { text: "The approved build doesn't support this computer's processor.", retry: false },
    REJECTED: { text: 'Your admin declined this request.', retry: false },
  };

  const failureInfo = (code) => (code && FAILURE[code]) || null;

  /** One friendly paragraph for a request row (server explanation first, our copy where we know better). */
  function friendlyOutcome(req) {
    const { status, decisionReason: reason } = req;
    const note = req.explanation || '';
    const name = req.softwareName || 'that app';
    const info = failureInfo(reason);
    switch (status) {
      case 'PROPOSED':
        return note;
      case 'AWAITING_APPROVAL':
        if (req.kind === 'new') return note || `I've asked IT to review ${name} and add it to the approved list. I'll install it as soon as it's approved.`;
        return note || `${name} needs an admin's approval. I've asked — I'll install it as soon as it's approved.`;
      case 'QUEUED':
        return note || `${name} is approved. I'm getting it ready to install.`;
      case 'DISPATCHED':
      case 'RUNNING':
      case 'VERIFYING':
        return `Working on ${name} now. You can keep using your computer.`;
      case 'SUCCEEDED':
        return `${name} is installed and verified. You're all set!`;
      case 'REJECTED':
        return note || `Your admin declined ${name}.`;
      case 'CANCELLED':
        return 'Okay, I cancelled that request.';
      case 'NOT_FOUND':
      case 'INCOMPATIBLE':
      case 'ALREADY_INSTALLED':
        return note || (info && info.text) || "I couldn't do that one.";
      case 'NEEDS_CLARIFICATION':
        return note;
      case 'FAILED':
      case 'BLOCKED':
      case 'EXPIRED':
      case 'FAILED_VERIFICATION':
        return (info && info.text) || note || `${name} didn't install.`;
      default:
        return note || '';
    }
  }

  return {
    NAME, MAX_LEN, wantsReinstall, guardInput, guardOutputText, isContinuePhrase, classifyTurn, planTurn, welcome, nextContext, failureInfo, friendlyOutcome,
  };
}));
