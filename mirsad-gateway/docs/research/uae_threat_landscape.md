# UAE scam threat landscape: what our gateway must catch

Researched 24 Nov 2026, 20:50–21:35 GST. Every claim carries a link. **[UNVERIFIED]** means I could not confirm it from a primary or reputable source tonight. **[C]** marks phrase-list entries we compiled from standard UAE service terminology, not quoted from a captured scam. **[V]** marks entries quoted verbatim from a reported scam message or page.

---

## 0. Priority list (by volume × fit for a URL gateway)

1. **Traffic fine, toll and parking payment pages** (RTA, Dubai Police, Abu Dhabi Police, Darb, Salik, RAK tolls). This is the biggest smishing wave and is industrialised by the Chinese-speaking "Smishing Triad" and "PostalFurious" groups.
2. **Parcel / delivery "small fee" pages** (Emirates Post, Aramex, generic couriers, Abu Dhabi Customs).
3. **Government ID / UAE PASS / ICP / TAMM credential and OTP theft**, including fake fast-track visa sites.
4. **Fake sites ranking in search results** (Nol recharge, Consumer Protection, tickets, "customer care"). Abu Dhabi Police and Dubai Police warned about this specifically in 2026.
5. **Bank / CBUAE "account blocked, update KYC/Emirates ID"** pages.
6. **Fake tickets and events** (Dubai Opera, Global Village, Museum of the Future), which are seasonal and running *now* (winter season).
7. **Fake investment / trading platforms and fake jobs**. These are high-loss but mostly social-media and WhatsApp led, with a landing site.
8. **Utility refund or bill pages** (DEWA).

---

## 1. Scam types in detail

### 1.1 Traffic fines, tolls and parking (RTA / Dubai Police / ADP / Darb / Salik / RAK)

**Delivery**
- SMS and iMessage from Gmail or foreign numbers. Senders can be spoofed to look like a toll company ([RAK Police via Khaleej Times, 5 Feb 2026](https://www.khaleejtimes.com/uae/rak-police-warn-motorists-fake-toll-payment-messages)).
- Phishing messages are sent from numbers in Malaysia and Thailand, and the phishing source code has simplified-Chinese comments (Group-IB "PostalFurious"; [Infosecurity Magazine](https://www.infosecurity-magazine.com/news/chinese-phishing-gang/)) **[UNVERIFIED: from search snippet; the page returned 403]**.
- Smishing Triad sends **50,000–100,000 messages a day** using leaked phone databases ([Resecurity, 11 Dec 2024](https://www.resecurity.com/en/blog/article/cybercriminals-impersonate-dubai-police-to-defraud-consumers-in-the-uae-smishing-triad-in-action)).

**Lure text examples [V]**
- "Darb-Alert … Pending Status: Please settle overdue toll fees (AED4.00) to avoid the issuance of a AED100.00 fine and traffic points today, Jan 20. **Reply Y to open the secure payment portal.**" ([Khaleej Times](https://www.khaleejtimes.com/uae/rak-police-warn-motorists-fake-toll-payment-messages)). "Reply Y" is an iMessage trick: replying makes the link clickable.
- RTA sample: "The traffic management department has notified you that your unpaid traffic fine (50 dirhams) is due soon. Please pay immediately to avoid an automatic addition of 500 dirhams today…" ([Gulf News, 23 Jan 2026](https://gulfnews.com/uae/new-dh500-dubai-scam-alert-for-unpaid-traffic-fines-rta-warns-1.500418185)).
- Arabic fake page, RTA warning of 17 Mar 2026: headline «مخالفات في الإمارات.. ادفع اليوم واحصل على خصم 50%», button «دفع المخالفات» ([Emarat Al Youm](https://www.emaratalyoum.com/local-section/other/2026-03-17-1.2025983)).
- Fake "90% traffic fine discount" accounts and sites ([Gulf News](https://gulfnews.com/uae/90-traffic-fine-discount-in-uae-it-could-be-a-fake-account-1.500145072)).
- Abu Dhabi Police warned about a link that misuses its logo and claims the recipient has a traffic violation ([Gulf News](https://gulfnews.com/uae/crime/scam-alert-abu-dhabi-police-warn-against-traffic-fine-suspicious-link-1.500243502), undated).

**Fake page**
- A copied e-government fine-payment form. A deliberately **tiny amount (AED 3–50)** gets the victim to enter card details, and the card is then charged far more at merchants registered to money mules ([Resecurity](https://www.resecurity.com/en/blog/article/cybercriminals-impersonate-dubai-police-to-defraud-consumers-in-the-uae-smishing-triad-in-action)).
- The same group also used a **fake UAE PASS form** to collect personal data.
- A cross-emirate gang (Ajman base, 22 POS devices seized) offered "discounted" fines as low as **Dh4**. There were 35 reports, 29 of them in Dubai ([Khaleej Times, 11 Apr 2026](https://www.khaleejtimes.com/uae/crime/dh4-traffic-fine-cross-emirate-fraud-network-busted-over-fake-sms-scam)).

**Domain patterns and indicators** (from [Resecurity](https://www.resecurity.com/en/blog/article/cybercriminals-impersonate-dubai-police-to-defraud-consumers-in-the-uae-smishing-triad-in-action))
- **Cheap TLDs: `.icu` (dominant), `.top`, `.site`, `.com`.**
- Random 4–7-letter SLDs with 2–3-letter subdomains, e.g. `ju[.]fhjre[.]icu`, `dub[.]xcber[.]icu`, `qad[.]edfsg[.]icu`, `aued[.]bxahj[.]icu`. Note the `dub`, `aued` and `qad` prefixes.
- Brand typos: `dubaipoliauey[.]top`, `dubaipoit[.]com`. More than **730 domains containing "Dubai Police" variants** were registered in the same period.
- Registrars: **Gname.com Pte. Ltd. (IANA 1923)** and **59.cn (IANA 2805)**. Nameservers `dm1/dm2.dns.com` and `a.share-dns.com` / `b.share-dns.net`. There is also an Omani `.om` asset, `traffic[.]itv[.]om`.
- Smishing Triad pages are reportedly geofenced to UAE IPs and mobile devices **[UNVERIFIED: secondary coverage; not in the Resecurity text I read]**.
- Official channels:
  - Darb sender IDs are "Darb" or "QMobility", and fake ones often use `.com` instead of `.ae` ([Arabwheels, 21 Jan 2026](https://www.arabwheels.ae/blog/uae-drivers-fake-darb-alert-scam-warning/)). Pay via TAMM.
  - Salik: salik.ae, the RTA app and 800-SALIK. Salik has also warned of clone sites and recharge phishing ([Gulf News](https://gulfnews.com/living-in-uae/safety-security/stay-vigilant-11-common-scams-exposed-by-uae-authorities-1.1732026136912), [Khaleej Times](https://khaleejtimes.com/uae/dubai-salik-warns-residents-against-scam-emails-social-media-posts-clone-websites)).

### 1.2 Parcel / delivery fees (Emirates Post, Aramex, couriers, Customs)

**Delivery**
- SMS, email and WhatsApp. Shortened URLs and a generic sender name such as "Delivery" ([Khaleej Times](https://www.khaleejtimes.com/business/fake-shipment-tracking-scams-surge-in-uae-and-region-heres-how-to-protect-yourself)).

**Lure**
- "Can't deliver, address incomplete, pay a small fee": Dh3 ([Abu Dhabi Police via Gulf News](https://gulfnews.com/uae/crime/dh3-delivery-scam-abu-dhabi-police-alert-uae-residents-of-fake-messages-1.500272577)), Dh4 ([Khaleej Times](https://www.khaleejtimes.com/uae/crime/uae-new-sms-scam-asks-residents-to-pay-dh4-to-claim-parcel)), up to Dh12 ([Emarat Al Youm 2022](https://www.emaratalyoum.com/local-section/accidents/2022-02-10-1.1597559)).
- One victim nearly lost AED 40,000 after trying to pay an AED 3 fee (same Gulf News article).

**Verbatim Arabic lures [V]** ([Emarat Al Youm, 14 Jan 2024](https://www.emaratalyoum.com/local-section/accidents/2024-01-14-1.1817064))
- «نحن بريد الإمارات.. لا نستطيع توصيل شحنتك»
- «لقد فقد ساعي البريد شحنتك بالصدفة، يرجى إعادة ملء بياناتك عبر الرابط»
- «حاولنا توصيل شحنتك، يرجى تأكيد بياناتك وإلا سيتم إرجاع الشحنة»
- «عنوان شحنتك لا يتضمن رقم المنزل، لذلك لن يمكن توصيله، يرجى تحديث البيانات على الرابط»
- Abu Dhabi Customs fake email subject (Aug 2026): «إشعار رسمي بحجز جمركي – يتطلب تصنيف التعرفة الجمركية (النظام المنسق)» ([Al Khaleej](https://www.alkhaleej.ae/2026-08-12/اقتصاد/أسواق-الإمارات/جمارك-أبوظبي-تحذر-من-رسائل-احتيالية)).

**Official channels**
- Emirates Post SMS comes only from EMIRATEPOST, EPGC or EmiratePST. Its email domains are @emiratespost.ae and @emiratesposthop.ae, payment is only via emiratespost.ae or the app, and it never sends links from private numbers ([Khaleej Times](https://khaleejtimes.com/life-and-living/uae-scam-alert-residents-warned-against-fake-delivery-messages-from-emirates-post)).
- Scammers have imitated at least 13 delivery brands and postal operators in the region ([The National 2022](https://www.thenationalnews.com/mena/2022/07/26/cybercriminals-pose-as-postal-services-to-target-middle-east-consumers)). TDRA has warned about courier-branded phishing ([The National 2023](https://thenationalnews.com/uae/2023/01/05/uae-authority-warns-public-over-phishing-links-posing-as-major-courier-companies)).

### 1.3 UAE PASS / ICP / Emirates ID / TAMM / visas
- **UAE PASS:** Digital Dubai and TDRA warned of phishing messages and links aimed at UAE PASS users ([Ground News summary](https://ground.news/article/digital-dubai-and-tdra-warn-of-phishing-campaigns-targeting-uae-pass-users); primary page returned 403).
  - Mechanism: the scammer types the victim's number into a UAE PASS-linked service, which triggers a real OTP, then calls the victim posing as an official and asks for the code ([Khaleej Times](https://khaleejtimes.com/uae/crime/got-uae-pass-otp-request-fraudsters-pose-as-officials-to-bully-victims-for-info)).
  - A fake UAE PASS web form was used in the Smishing Triad campaign ([Resecurity](https://www.resecurity.com/en/blog/article/cybercriminals-impersonate-dubai-police-to-defraud-consumers-in-the-uae-smishing-triad-in-action)).
  - In March 2026, scammers impersonated officials to obtain UAE PASS and Emirates ID details after regional missile strikes ([The Register](https://www.theregister.com/2026/03/02/dubai_iran_sim_swap/), [Gulf News](https://gulfnews.com/uae/crime/dubai-police-caution-residents-against-fake-calls-seeking-uae-pass-details-1.500460239)).
  - MOHAP advises reaching UAE PASS only through the app or the typed official URL ([MOHAP](https://mohap.gov.ae/en/w/safeguarding-uae-pass-a-guide-to-a-secure-digital-identity)).
- **ICP:**
  - Fake websites and calls use the ICP logo. "ICP's employees never ask to share one-time passwords or digital identity verification numbers." Use only the UAE ICP app and the official site ([Gulf Today, 30 Apr 2026](https://www.gulftoday.ae/news/2026/04/30/beware-of-fraudsters-using-icp-name-logo-for-fake-calls-and-website-uae-warns-residents); [Gulf News](https://gulfnews.com/uae/government/uae-warns-against-phone-scams-fake-websites-impersonating-icp-logo-1.500524560)).
  - Fake "fast-track visa/residency" websites and ads, Jul 2025 ([Gulf News](https://gulfnews.com/uae/government/icp-warns-uae-residents-avoid-fake-online-accounts-for-fast-tracked-services-1.500214245)).
- **Fake visa/residency services and fake domestic-worker recruitment sites** are on Abu Dhabi Police's June 2026 list ([Gulf News, 7 Jun 2026](https://gulfnews.com/uae/crime/abu-dhabi-police-warn-public-about-fake-links-in-search-engines-1.500566188)).
- **TAMM:** I found no TAMM-specific advisory tonight **[UNVERIFIED]**. TAMM is the official Abu Dhabi payment route for Darb and fines ([Arabwheels](https://www.arabwheels.ae/blog/uae-drivers-fake-darb-alert-scam-warning/)), so treat "TAMM" plus "pay" on a non-`tamm.abudhabi` domain as high risk.
- **Page look:** a government header with logo, a lookup by Emirates ID, plate or file number, then personal data, card details and the OTP.

### 1.4 Bank KYC / account blocked / CBUAE impersonation
- **Lure:** "Your card/account is blocked; update your data (Emirates ID) via this link" ([Gulf News](https://gulfnews.com/living-in-uae/banking/your-card-is-blocked-how-to-protect-yourself-from-bank-fraud-1.1629294149735)). Variant: call this number to unblock an ATM card ([Khaleej Times](https://www.khaleejtimes.com/nation/dubai/beware-new-atm-scam-message-in-uae-can-drain-your-bank-account)).
- **Caution on false positives:** real banks *do* send KYC links when an Emirates ID expires ([Gulf News explainer](https://gulfnews.com/ask-gulf-news/ask-gulf-news-how-to-update-your-bank-kyc-in-the-uae-when-your-emirates-id-expires-1.500320726)). So a KYC link on the bank's official domain must be ALLOWED.
- **Bank rules:** ADCB never asks for credentials, OTP or card details via SMS, links or calls ([ADCB](https://www.adcb.com/en/consumer-education-awareness/fraud-awareness/protecting-your-banking-information)). The CBUAE never contacts individuals via social media ([Khaleej Times](https://www.khaleejtimes.com/uae/government/uae-central-bank-warns-of-fraud-whatsapp-messages)). CBUAE has a fraud-reporting page ([centralbank.ae](https://www.centralbank.ae/en/our-operations/risk-management/cyber-security-centre-of-excellence-1/fraudulent-reporting/)). CBUAE has ordered banks to move beyond SMS OTPs ([Gulf News](https://gulfnews.com/business/banking/uae-banks-ordered-to-tighten-anti-fraud-security-beyond-otps-1.500548327)).

### 1.5 Fake sites in search results / fake customer care / Consumer Protection
- **Abu Dhabi Police, 7 Jun 2026:** fake links and misleading ads in search-engine results, "promoting unrealistically low prices" ([Gulf News](https://gulfnews.com/uae/crime/abu-dhabi-police-warn-public-about-fake-links-in-search-engines-1.500566188); Arabic: «الروابط الوهمية والإعلانات المضللة التي قد تظهر في نتائج محركات البحث», [Emarat Al Youm](https://www.emaratalyoum.com/local-section/accidents/2026-06-07-1.2052998)).
- **Abu Dhabi Police, 17 Apr 2026:** fake sites placed near the top of search results imitating government services and consumer-protection platforms ([Gulf News](https://gulfnews.com/uae/emergencies/abu-dhabi-police-warn-of-fake-google-links-stealing-banking-data-1.500510220)).
- **Dubai Police, Jul 2026:** fake Consumer Protection sites found through search and social media push victims to install **remote-access apps** ([Khaleej Times](https://www.khaleejtimes.com/uae/dubai-police-fake-consumer-protection-links-banking-scam-warning)). Abu Dhabi Police issued a similar warning ([Gulf News](https://gulfnews.com/amp/story/uae%2Fabu-dhabi-police-warn-against-fake-consumer-protection-websites-on-search-engines-1.500573350)).
- **Nol recharge:** "the first four sites that pop up … when you Google 'Nol recharge' are all fraudulent". They asked for the Nol tag ID, email and amount, then an OTP, and one victim was charged Dh1,051 instead of Dh30 ([Khaleej Times, Jan 2024](https://khaleejtimes.com/uae/dubai-residents-lose-thousands-of-dirhams-to-fake-rta-global-village-websites)). The RTA then issued a warning ([Khaleej Times](https://khaleejtimes.com/uae/transport/dubai-rta-issues-warning-after-khaleej-times-exposes-deceptive-nol-card-scam)).
- **Fake helpline numbers:** I found no UAE-specific primary report of fake bank or airline numbers on Google Maps **[UNVERIFIED for UAE]**. The pattern is documented globally, including scam call-centre numbers surfacing in Google AI Overviews ([The Points Guy](https://thepointsguy.com/news/travel-scam-google-ai-search-results)), and Dubai Police describe fake calls posing as banks ([Gulf News](https://gulfnews.com/uae/crime/dubai-police-warn-of-rise-in-fake-calls-posing-as-officials-and-banks-1.500503458)). Detection should **extract phone numbers from pages and listings** and compare them with the brand's official number.
- **Dubai Police on the most common scams (Aug 2026):** fake social ads, and **cloned websites differing by one letter or a slightly different domain**. Report via eCrime ([Khaleej Times](https://www.khaleejtimes.com/uae/dubai-police-common-online-scams-uae-fake-ads)).

### 1.6 Fake tickets and events (seasonal, active now)
- **Dubai Opera, 16 Nov 2026:** impostor `dubopera.com` vs the official `dubaiopera.com`. The official sellers are dubaiopera.com and platinumlist.net. The fake sites "may also show up high in online search results" ([The National](https://www.thenationalnews.com/news/uae/2026/11/16/dubai-opera-issues-warning-about-proliferation-of-fake-ticket-websites/)).
- Global Village (three OTPs entered, Dh1,040 lost) and Museum of the Future (`cargovanexpeditinginny.com`, Dh6,000) ([Khaleej Times](https://khaleejtimes.com/uae/dubai-residents-lose-thousands-of-dirhams-to-fake-rta-global-village-websites)).
- Dubai Police, Dec 2025: fake ticket sites at holiday time; report via the app or 901 ([Gulf News](https://gulfnews.com/uae/crime/dubai-police-warn-of-online-scams-involving-fake-tickets-1.500389578)).
- **Pattern:** a typosquat or an unrelated (often aged or compromised) domain with "discount up to 50%" wording.

### 1.7 Investment / trading and fake jobs
- **MOI, Jun 2025:** a social-media "secure trading platform" with a "virtual balance". The victim lost Dh42,000, then paid another Dh42,000 to "unfreeze" the account. Report via the MOI app's Cybercrime platform and check licences with the SCA ([Gulf News](https://gulfnews.com/uae/crime/dh42000-lost-in-scam-uae-ministry-of-interior-warns-against-fake-trading-platforms-1.500180688)).
- A Dubai retiree lost more than Dh400,000 to an investment scam ([Khaleej Times](https://www.khaleejtimes.com/police-warn-residents-against-scammers-online-fraud)).
- **Jobs:** MoHRE offers carry a verifiable serial number and barcode (call centre 600 590000). Requests for fees, bank details or OTPs mean scam ([Khaleej Times](https://www.khaleejtimes.com/jobs/uae-warn-fake-offers-recruitment-scams), [The National](https://www.thenationalnews.com/news/uae/2025/09/04/uae-jobs-scam)). Dubai Police warn of fake part-time jobs used for money mules ([Khaleej Times](https://khaleejtimes.com/uae/crime/dubai-police-warn-fake-part-time-job-offers)).
- **Page look:** a dashboard with a fake balance, a "deposit to withdraw" step, a WhatsApp/Telegram contact and celebrity or official logos.

### 1.8 Utilities (DEWA / ADDC)
- DEWA "refund for overpaid bill" scam: Dh2,300 lost in six minutes ([The National, Jan 2025](https://thenationalnews.com/news/uae/2025/01/18/dewa-scam-dubai)). The "accept online" link goes to a random domain registered abroad ([Gulf News](https://gulfnews.com/living-in-uae/safety-security/you-have-a-refund-on-your-electricity-bill-new-scam-and-how-you-can-stay-safe-1.1726143766586)). DEWA never asks you to "download your bill to pay" (same source). ADDC: nothing found **[UNVERIFIED]**.

### 1.9 Other items on the police lists
- Abu Dhabi Police's "Be Careful" campaign covers nine areas: phone scams, fake links, remote-access apps, deposits for premium numbers or vehicles, fake jobs, unknown friend requests, misleading online ads, property fraud and investment scams ([Gulf News, Oct 2025](https://gulfnews.com/uae/crime/abu-dhabi-police-recover-dh140-million-from-online-fraud-cases-1.500316909)).
- The June 2026 list adds counterfeit tickets, fake visa services, unlicensed insurance, too-good travel deals, fake sales of vehicles "confiscated by Abu Dhabi Customs" and fake real estate ([Gulf News](https://gulfnews.com/uae/crime/abu-dhabi-police-warn-public-about-fake-links-in-search-engines-1.500566188)).
- **Charity scams:** no UAE primary source found tonight **[UNVERIFIED]**.

---

## 2. Phrase lists for detection features

Use these as weighted regexes on the page text, title and button labels **plus** the SMS lure if the gateway has it. Combine them as *payment ask × urgency × brand × non-official domain*. Arabic matching should normalise alef forms (أ إ آ → ا), ta marbuta (ة → ه) and ya (ى → ي), and strip tatweel and diacritics.

### 2.1 English
| Category | Phrases |
|---|---|
| Fines and tolls | [V] "unpaid traffic fine", "overdue toll fees", "Pending Status", "avoid the issuance of a … fine", "traffic points", "automatic addition of 500 dirhams", "Reply Y to open the secure payment portal", "pay today and get 50% discount", "90% discount" · [C] "black points", "traffic violation", "fine inquiry", "plate number", "pay fines" |
| Delivery | [V] "we could not deliver your parcel", "address incomplete", "update your details", "small delivery charge", "pay AED 3 / AED 4" · [C] "customs clearance fee", "re-schedule delivery", "tracking number", "package on hold" |
| Identity / gov | [C] "UAE PASS verification", "Emirates ID expired", "update Emirates ID", "verify your identity", "fast-track visa", "residency renewal", "ICP" |
| Bank | [V] "Verify your bank account", "You are entitled to a refund", "You have won", "Exclusive discounted credit card offer" ([Cyber Security Council via Khaleej Times, 1 Feb 2026](https://www.khaleejtimes.com/uae/cyber-security-council-warns-rise-fraudulent-messages)) · [C] "your card has been blocked", "account suspended", "KYC update required", "enter OTP", "CVV" |
| Investment / jobs | [C] "guaranteed daily profit", "withdrawal fee", "unfreeze your account", "part-time job, daily income", "processing fee" |

### 2.2 Arabic
| Category | Phrases |
|---|---|
| Fines and tolls | [V] «مخالفات في الإمارات»، «ادفع اليوم واحصل على خصم 50%»، «دفع المخالفات» · [C] «مخالفة مرورية غير مدفوعة»، «سداد المخالفات»، «رسوم بوابات التعرفة المرورية»، «رسوم متأخرة»، «نقاط سوداء»، «تجنب الغرامة»، «الاستعلام عن المخالفات»، «رقم اللوحة» |
| Delivery | [V] «لا نستطيع توصيل شحنتك»، «يرجى إعادة ملء بياناتك عبر الرابط»، «يرجى تأكيد بياناتك وإلا سيتم إرجاع الشحنة»، «يرجى تحديث البيانات على الرابط»، «إشعار رسمي بحجز جمركي» · [C] «رسوم التوصيل»، «رسوم جمركية»، «رقم التتبع»، «إعادة جدولة التوصيل» |
| Identity / gov | [C] «الهوية الإماراتية منتهية»، «تحديث بيانات الهوية»، «رمز التحقق»، «كلمة المرور لمرة واحدة»، «التحقق من الهوية الرقمية»، «تأشيرة سريعة»، «تجديد الإقامة» |
| Bank | [C] «تم إيقاف بطاقتك»، «تم تجميد حسابك»، «تحديث البيانات المصرفية»، «أدخل رمز OTP»، «رقم البطاقة»، «تاريخ الانتهاء»، «لقد ربحت»، «يحق لك استرداد مبلغ» |
| Urgency | [C] «فوراً»، «اليوم»، «خلال 24 ساعة»، «آخر فرصة»، «سيتم إلغاء»، «تجنب الإيقاف» |

### 2.3 Structural indicators (high weight)
- A card-number, CVV or expiry input plus an OTP step on a domain that is not the brand's official one.
- An AED amount under about 20 together with a penalty threat (fee bait).
- Emirates ID (`784-YYYY-NNNNNNN-N`), plate or file-number lookup forms on non-gov domains.
- UAE government logos or titles (Dubai Police, RTA, TAMM, UAE PASS, ICP) where the domain is not `*.gov.ae`, `tamm.abudhabi`, `uaepass.ae`, `rta.ae` etc.
- **`.gov.ae` is restricted to government entities.** .ae WHOIS shows `Eligibility Type: Government Approved` for adpolice.gov.ae [TESTED via whois.aeda.net.ae]. That is a strong ALLOW anchor.

### 2.4 Official-domain seed list (allowlist; reachable 24 Nov 2026 [TESTED unless noted])
`tamm.abudhabi`, `uaepass.ae`, `icp.gov.ae`, `adpolice.gov.ae`, `dubaipolice.gov.ae`, `ecrimehub.gov.ae`, `rta.ae`, `salik.ae`, `itc.gov.ae` (Darb operator **[UNVERIFIED mapping]**), `emiratespost.ae`, `dewa.gov.ae`, `centralbank.ae`, `mohre.gov.ae`, `dubaiopera.com`, `platinumlist.net`, `aramex.com`. Extend with the official bank domains (ADCB, FAB, Emirates NBD, Mashreq, DIB, ADIB, RAKBANK, CBD), `etisalat.ae` / `eand.ae` and `du.ae`, and **verify each before hard-coding**.

---

## 3. UAE reporting channels (export targets)

| Channel | Scope | How | Source |
|---|---|---|---|
| **Abu Dhabi Police "Aman"** | Abu Dhabi (accepts cyber and fraud tips) | Toll-free **8002626**, SMS **2828**, email **aman@adpolice.gov.ae**, ADP smart app ("Police Station in Your Phone") | [Gulf News Jun 2026](https://gulfnews.com/uae/crime/abu-dhabi-police-warn-public-about-fake-links-in-search-engines-1.500566188), [Emarat Al Youm](https://www.emaratalyoum.com/local-section/accidents/2026-06-07-1.2052998) |
| **Dubai Police eCrime** | Dubai | **ecrime.ae** / **ecrimehub.gov.ae**, "Report" button. Needs mobile, email and Emirates ID or passport. Also the Dubai Police app, 901 (non-emergency) | [Emirates 24/7 guide](https://www.emirates247.com/uae-guide/dubai-police-ecrime-hub-how-to-report-cybercrime-online-recover-from-scams-and-protect-yourself/6353), [Khaleej Times](https://www.khaleejtimes.com/uae/dubai-police-fake-consumer-protection-links-banking-scam-warning) |
| **MOI Cybercrime platform** | Federal | "MOIUAE" app | [Gulf News](https://gulfnews.com/uae/crime/uae-ministry-of-interior-launches-cybercrime-platform-5-tips-to-avoid-online-fraud-1.500215172) |
| **u.ae list** | Federal index | Lists Aman, eCrime and the "My Safe Society" app | [u.ae](https://u.ae/en/information-and-services/justice-safety-and-the-law/cyber-safety-and-digital-security/report-cybercrimes-online) |
| **aeCERT / TDRA** | National CERT, URL blocking via e&/du | Public may report incidents to aeCERT. TDRA can order ISP blocking | [u.ae cyber safety](https://u.ae/en/information-and-services/justice-safety-and-the-law/cyber-safety-and-digital-security) |
| **CBUAE** | Financial fraud impersonating the CBUAE | Fraudulent-reporting page | [centralbank.ae](https://www.centralbank.ae/en/our-operations/risk-management/cyber-security-centre-of-excellence-1/fraudulent-reporting/) |
| **e&** | Phishing emails using the e& brand | Forward to documents@eand.com. SMS sender IDs are EtisalatINF and MY_ETISALAT | [The National](https://www.thenationalnews.com/uae/2023/07/21/etisalat-users-in-the-uae-latest-targets-of-cyber-criminals), [eand.ae](https://www.eand.ae/en/c/phishing-and-fraud/sms.html) |
| **Abu Dhabi Judicial Dept hotline** | Ticket scams | 8002626 | [Zawya](https://www.zawya.com/en/legal/crime-and-security/uae-residents-warned-of-fake-event-tickets-sold-on-social-media-sc7ccsb7) |

**Pilot route:** the gateway produces a case file. Three exports follow from it: (1) a **police export** to Aman or eCrime as a bilingual PDF and JSON with screenshot, timestamps (GST), redirect chain, WHOIS and hosting; (2) a **TDRA/aeCERT block request** with the domain list plus evidence, fed into the existing IAM mechanism that obliges e&/du to block; (3) **registrar, host and Cloudflare abuse emails** (see `industry.md` section 4).

---

## 4. Statistics for the pitch (each with source)

| Stat | Source |
|---|---|
| Fraudulent messages up about **35%** in 2025 (UAE Cyber Security Council) | [Khaleej Times/WAM, 1 Feb 2026](https://www.khaleejtimes.com/uae/cyber-security-council-warns-rise-fraudulent-messages) |
| **>75%** of cyber intrusions start with phishing emails or fake messages (CSC) | [WAM](https://www.wam.ae/en/article/bzkavgz-uae-cyber-security-council-75-cyberattacks-start) |
| Social engineering is used in about **98%** of attacks (CSC, Sep 2025) | [WAM](https://www.wam.ae/en/article/bltjnlq-uae-cyber-security-council-98-attacks-exploit) |
| Abu Dhabi Police: **15,642** cybercrime cases in 2 years; **Dh140 million** recovered and returned (Oct 2025) | [Gulf News](https://gulfnews.com/uae/crime/abu-dhabi-police-recover-dh140-million-from-online-fraud-cases-1.500316909) |
| GASA/Trend Micro 2025 (n=1,000, Jan 2026): 7 in 10 residents met a scam; an encounter **every 3 days (~111/yr)**; **1 in 3 lost money** in the past year; top types shopping 70%, investment 67% | [GASA](https://gasa.org/knowledge-base/blog/scams-hit-uae-residents-every-three-days-on-average-new-research-finds) |
| GASA/BioCatch 2024: **27%** lost money, average loss **US$2,194 (≈Dh8,058)**; only 9% fully recovered; only 30% reported to police | [BioCatch press release](https://www.biocatch.com/press-release/uae-residents-lose-millions-to-scams-2024), [WAM](https://www.wam.ae/en/article/b6f93te-2024-state-scams-uae-survey-reveals-65-scam) |
| Smishing Triad: **50k–100k SMS/day**; **>730** "Dubai Police" look-alike domains in one period | [Resecurity](https://www.resecurity.com/en/blog/article/cybercriminals-impersonate-dubai-police-to-defraud-consumers-in-the-uae-smishing-triad-in-action) |
| **>8,000** conflict-themed fraudulent websites registered in one month (Mar 2026) | [Khaleej Times](https://www.khaleejtimes.com/world/asia/over-8000-middle-east-conflict-themed-fake-websites-threat-residents) |
| TDRA: **43%** of blocked sites in one quarter were phishing or fraud (377 of 883; year unclear) | [Khaleej Times](https://www.khaleejtimes.com/uae/crime/uae-17-categories-of-online-content-websites-that-are-blocked-in-the-emirates) |
| Dubai: about **50%** of reported fraud is social-media related; 103 fraud accounts shut in Q2 2026 | [Khaleej Times](https://www.khaleejtimes.com/uae/dubai-police-block-103-social-media-accounts-used-for-online-scams) (as summarised in search; **[UNVERIFIED: not opened]**) |
| Kaspersky: phishing in the UAE up 21.2% in Q2 2025 | via Mastercard analysis **[UNVERIFIED: not opened]** ([PDF](https://www.mastercard.com/news/media/xyymlzo2/uae-cyber-threat-landscape-analysis-final.pdf)) |

**Pitch line:** police already recover money *after* the fact (Dh140M over 2 years in Abu Dhabi), and only 30% of victims report. A pre-click gateway with police-ready evidence moves the intervention to *before* the card is entered, and creates a report automatically for every block.
