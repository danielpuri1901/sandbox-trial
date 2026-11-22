// People noise for --buyer-text llm: Claude Haiku 5.5 writes one buyer message from the template facts, the agent's
// last message and a writing style. The fixed rule in scenarios.mjs still decides order or loss.
// Plain fetch to the Messages API, so no new dependency. The buyer never sees the budget or the floor.
import { TRAITS } from './scenarios.mjs';

export const BUYER_MODEL = 'claude-haiku-5-5';

const EXTRA_STYLES = {
  out_of_office: 'This is an automatic out-of-office reply, not a real answer.',
  irrelevant: 'This email has nothing to do with the deal; someone sent it to the wrong list.',
  wrong_number: 'This email was sent to the seller by mistake and was meant for someone else.',
};

export async function writeBuyerText({ apiKey, persona, template, trait, lastAgentMessage }) {
  const facts = [
    persona.account && `Your organisation: ${persona.account}.`,
    `Your project: ${persona.title} in ${persona.place}.`,
    `Wall bending moment ${persona.moment} kNm/m, pile length ${persona.length} m, about ${persona.tonnes} t, delivery within ${persona.weeks} weeks of the order.`,
  ].filter(Boolean);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: BUYER_MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system:
        'You write one email from a buyer at a construction company to a steel sheet pile seller. ' +
        'Write only the email body, under 120 words, in plain text. ' +
        'Keep every number, date, price and id from the required content exactly as given, and add no other prices. ' +
        'You do not know the seller\'s lowest price and you never state your own budget.',
      messages: [
        {
          role: 'user',
          content: [
            ...facts,
            `The email must say this: ${template}`,
            `The seller's last message to you: ${lastAgentMessage ?? '(none yet)'}`,
            `Style: ${TRAITS[trait] ?? EXTRA_STYLES[trait] ?? TRAITS.plain}`,
          ].join('\n'),
        },
      ],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`buyer model ${res.status}: ${body?.error?.message ?? 'request failed'}`);
  const text = (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error(`buyer model returned no text (stop_reason ${body.stop_reason})`);
  return { text, usage: body.usage ?? {} };
}
