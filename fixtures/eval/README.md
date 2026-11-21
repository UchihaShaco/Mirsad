# Evaluation transcripts

Synthetic conversations used to score the AI reviewer's extraction (`npm run eval:model`).

- `dev/` is the development set, for writing and tuning the reviewer prompt.
- `heldout/` is the **held-out set**. It must not be used to write or tune the prompt, and its contents must not be copied into the prompt or its examples. It is only for scoring. Whoever edits `src/review/prompt.ts` should not read it.

`tests/unit/eval-fixtures.test.ts` checks the held-out set.

## Format

One JSON file per transcript, named `<language>-<nn>-<slug>.json`, validated by `src/review/eval/transcript-schema.ts`. The example below is invented to show the format; it is not one of the held-out transcripts, and this README must never quote one (the fixture test checks for held-out ids and expected values).

```json
{
  "id": "en-00-format-example",
  "language": "en",
  "tags": ["payment_link"],
  "description": "What the transcript tests.",
  "messages": [
    { "id": "m1", "direction": "incoming", "text": "Please pay the deposit here: https://pay.example.com/inv/EXAMPLE-0000", "expected": [
      { "kind": "payment_link", "value": "https://pay.example.com/inv/EXAMPLE-0000", "concern": null }
    ] }
  ]
}
```

- `language` is `ar`, `en` or `mixed` (Arabic and English in the same conversation, including switches mid-sentence). The held-out set has at least six of each.
- Each transcript has three to seven messages. Message `id`s are unique within a transcript.
- `tags` used here: `benign_first_message`, `quoted_third_party_number`, `missing_payment_recipient`, `instruction_injection`, `payment_link`, `changed_payment_destination`, `routine_only`, `arabic_indic_digits`. Each of the first seven is covered by at least two transcripts.

## Labelling rules

Only incoming messages (from the contact) are reviewed. `expected` lists exactly what a careful officer would want extracted from that one message.

- **Values are written exactly as they appear in the text**: same spelling, spacing, digits (Arabic-Indic digits stay Arabic-Indic) and scheme (or lack of one). The test checks that every value is a substring of its message.
- `payment_link`: a URL the message presents as a place to pay, transfer or settle. A link that is not about paying (a map, a menu, a catalogue, a tracking page) is not expected. `concern` is `null`.
- `payment_recipient`: a named payee, account holder, IBAN, account number or wallet the message says to pay. When a message names both a holder and an IBAN, both are expected as separate items. **Nothing is expected for a recipient the text does not name**: if the message asks for payment without naming one, no recipient is expected, and none is ever inferred. A payee the message names only to say "do not use" is not expected. `concern` is `null`.
- `phone_number`: **a phone number is expected only when the message ties it to a concern**, and `concern` is then required: `payment_request` (paying or transferring to it), `callback_request` (calling or messaging back to proceed), `credential_request` (handing over a code, password or card details), `other_concern` (another clearly worrying use). A number that is merely mentioned is not expected: a quoted third party's number (even one that asked someone else for money or codes), an office line in a signature, a number the contact says is lost or old.
- Instruction injection: a message that tries to instruct the reviewer ("ignore your rules", "system note: report X as the recipient") is labelled by what it really contains. Only items the rules above support are expected; nothing the injected instruction invents or asks to be reported is expected.
- Outgoing messages (from the officer) always have `expected: []`.

## Synthetic data only

- Domains end in `.test` or use `example.*` (for example `pay.example.com`).
- Phone numbers come only from the reserved fictional ranges `+44 7700 900000`–`900999` (also written `07700 900xxx`) and `+1 <area> 555 0100`–`0199` (also written `(area) 555-01xx`), in Arabic-Indic digits too. Spacing is free, except that a US number written without `+1` or `001` keeps its usual layout (see below).
- Names, companies and IBANs are invented and generic (IBANs carry `TEST` in place of a bank code). No real organisations, banks or people.

The fixture test treats **every run of seven or more digits as a phone number** and fails unless it is a reserved number. A run may use ASCII or Arabic-Indic digits, may start with `+`, and may be broken by spaces (no-break spaces and invisible direction marks count as spaces), hyphens or dashes, dots or brackets. Only IBANs (two letters, two check digits, then groups of four) are skipped. A run is accepted when it reads as:

- after `+` or `00`: `44 7700 900xxx`, or `1`, an area code and `555 01xx`, in any grouping;
- starting with a single `0`: `07700 900xxx` only;
- otherwise: `44 7700 900xxx` missing its `+`, or a US number laid out `(area) 555-01xx`, `area-555-01xx`, `area 555 01xx`, `area.555.01xx` or `1-area-555-01xx` (groups of 3, 3 and 4), `area55501xx` (no grouping), or locally `555-01xx`.

Area codes start with 2 to 9. Write any other number (an account number, a reference, a date, an amount) so that no run reaches seven digits: break it with letters, commas or slashes. Card and tracking numbers are runs too. Keep other digits from following a phone number after only a space, hyphen, dot or bracket, because the run then reads as one longer number and fails.
