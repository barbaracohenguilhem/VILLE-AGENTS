import type { ProviderKind } from '../types.ts';
import { chance, pick, sleep } from '../util/random.ts';
import type { CompleteRequest, LLMClient, OfflineMeta } from './types.ts';

/**
 * Scripted demo behavior, available only when explicitly configured offline.
 */
export class OfflineClient implements LLMClient {
  readonly provider: ProviderKind = 'offline';
  readonly model = 'scripted';
  readonly label: string;
  readonly mode = 'demo' as const;
  readonly status = 'demo' as const;
  readonly canComplete = true;
  readonly online = false;
  readonly requests = 0;
  readonly note: string;

  constructor(reason: string) {
    this.note = reason;
    this.label = 'offline · scripted demo';
  }

  async complete(req: CompleteRequest): Promise<string> {
    await sleep(150 + Math.random() * 350);
    const meta: OfflineMeta = req.meta ?? { name: 'someone', room: 'kitchen', others: [], rooms: [], objects: [] };
    switch (req.kind) {
      case 'action':
        return JSON.stringify(action(meta));
      case 'reply':
        return JSON.stringify(reply(meta));
      case 'plan':
        return JSON.stringify(plan());
      case 'reflection':
        return JSON.stringify({
          insights: [
            'Life in this house has a rhythm I am starting to enjoy.',
            `I should spend more time with ${meta.others[0] ?? 'the others'}.`,
            'I keep forgetting to finish what I start.',
          ],
          goalUpdates: [{ index: 0, progress: 25 }],
        });
    }
  }
}

const OPENERS = [
  'Hey — how is your day going so far?',
  'Have you eaten anything yet? I was about to make something.',
  'Do you ever feel like this house has its own weather?',
  'What are you working on today?',
  'I had the strangest dream last night. Want to hear it?',
  'Any plans for tonight?',
  'Quick question: is the hot water being weird for you too?',
];

const REPLIES = [
  'Honestly? Better than yesterday. You?',
  'Ha, that is exactly what I was thinking.',
  "I'm not sure I agree, but go on.",
  'Tell me more — I have a few minutes.',
  'That reminds me of something, actually.',
  "Let's do that this weekend.",
  'You always say that!',
];

const CLOSERS = [
  'Anyway, I should get back to it. Talk later!',
  "Okay, I'm off — catch you at dinner.",
  'Right, I need coffee before I say anything else.',
  'Good chat. Let me know how it goes.',
];

const DOINGS = [
  'flipping through an old book',
  'staring out of the window, thinking',
  'tidying things that did not need tidying',
  'humming a tune nobody recognises',
  'scribbling notes on a scrap of paper',
  'stretching after sitting too long',
];

const MOODS = ['content', 'curious', 'restless', 'calm', 'amused', 'thoughtful', 'sleepy'];

function action(meta: OfflineMeta) {
  const mood = pick(MOODS);
  if (meta.others.length > 0 && chance(0.5)) {
    const target = pick(meta.others);
    return {
      thought: `Might as well talk to ${target}.`,
      action: 'say',
      target,
      content: pick(OPENERS),
      mood,
    };
  }
  if (meta.rooms.length > 1 && chance(0.35)) {
    const target = pick(meta.rooms.filter((r) => r !== meta.room));
    return {
      thought: 'A change of scenery would be nice.',
      action: 'move',
      target,
      content: `wandering over to the ${target}`,
      mood,
    };
  }
  if (meta.objects.length > 0 && chance(0.7)) {
    return {
      thought: 'Keeping busy.',
      action: 'do',
      target: '',
      content: `fiddling with the ${pick(meta.objects)}`,
      mood,
    };
  }
  return { thought: 'Just being here for a moment.', action: chance(0.5) ? 'do' : 'rest', target: '', content: pick(DOINGS), mood };
}

function reply(meta: OfflineMeta) {
  const turn = meta.turn ?? 1;
  const end = turn >= 3 || (turn >= 2 && chance(0.4));
  return {
    thought: end ? 'Time to wrap this up.' : 'Keep it going.',
    content: end ? pick(CLOSERS) : pick(REPLIES),
    end,
    impression: end && meta.partner ? `${meta.partner} is easy to talk to.` : '',
    warmth: end && chance(0.6) ? 1 : 0,
  };
}

function plan() {
  return {
    plan: [
      { time: '08:00', activity: 'coffee and a slow start in the kitchen' },
      { time: '10:00', activity: 'work on a personal project' },
      { time: '13:00', activity: 'lunch with whoever is around' },
      { time: '15:00', activity: 'a walk in the garden' },
      { time: '19:00', activity: 'dinner and conversation in the living room' },
      { time: '22:00', activity: 'wind down and read before bed' },
    ],
    mood: pick(MOODS),
  };
}
