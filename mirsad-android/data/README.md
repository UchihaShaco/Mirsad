# Mirsad data

Everything in this folder is **synthetic**. Every phone number is zero-filled fiction (`+971500000003`,
`+440000000001`), every IBAN is zero-filled, every scam domain ends in `.example`, and every legitimate link
points only to an official host from the allowed list below. Nothing here comes from a real victim, a real
case or a real message. Real, anonymised police case data is the intended next step and is not included.

## Files

| File | Written by | Purpose |
|---|---|---|
| `seed_messages.csv` | hand | 22 hand-written seed examples (14 scam, 8 legit) in English and Arabic |
| `generated_messages.csv` | `./gradlew :core:trainModel` | templated variants from `MessageGenerator` (seeded, deterministic); regenerated on every training run, do not edit |
| `legit_suite.csv` | hand | legitimate UAE-style messages that must never be held; gates every build through `LegitimateMessagesTest` |
| `evaluation.md` | `./gradlew :core:trainModel` | held-out metrics of the last training run, do not edit |

## CSV schema

RFC 4180: comma separated, UTF-8, header row, fields containing commas, quotes or line breaks are quoted and
quotes are doubled. Columns, in order:

| Column | Values | Meaning |
|---|---|---|
| `label` | `scam`, `legit` | Ground truth |
| `lang` | `en`, `ar`, `ar-latn` | Language of the text; `ar-latn` is Arabic written in Latin letters ("Arabizi"), e.g. `edfa3 3 dirham`. Maps to `Language.EN`, `Language.AR`, `Language.LATIN_ARABIC` |
| `channel` | `SMS`, `CHAT` | Where the message arrived (`Channel.SMS`, `Channel.CHAT`). Calls carry no text and never appear |
| `sender` | string | Sender as seen: a zero-filled E.164 number, an alphanumeric sender ID (`ADCB`, `Aramex`) or a person's name (`Khalid`, `أبو عمر`) |
| `text` | string | The message text, verbatim |
| `synthetic` | `true`, `false` | `true` for every row in this folder. `false` is reserved for rows that come from real, consented feedback |

The app's feedback export ("Not a scam" / "Confirmed scam" rows exported from the phone) uses the same
columns plus a trailing `source` column with the value `feedback`, so exported rows can be appended to these
files and used by the trainer unchanged (extra columns are ignored on read).

## Allowed official hosts for legitimate rows

`u.ae`, `icp.gov.ae`, `adpolice.gov.ae`, `rta.ae`, `salik.ae`, `dewa.gov.ae`, `addc.ae`, `uaepass.ae`,
`tamm.abudhabi`, `emiratespost.ae`, `etisalat.ae`, `du.ae`, `bankfab.com`, `emiratesnbd.com`, `adcb.com`,
`adib.ae`, `mashreq.com`, `aramex.com`.

## Training

```
./gradlew :core:trainModel
```

`app.mirsad.core.ml.train.TrainerMainKt` regenerates `generated_messages.csv` (seed + generated = 800 rows,
balanced), holds out 20 % stratified by label, trains the hashed n-gram logistic regression, prints and writes
precision / recall / F1 / confusion matrix to `evaluation.md`, then retrains on all rows and writes
`app/src/main/assets/model.bin` (`lr-ngram-v1`). Pure Kotlin, no Python, no network.
