# WhatsApp for a personal hackathon demo

A tester messages your WhatsApp Business number. Their text appears in Mirsad. **Dispatch** asks Gemini through OpenRouter to assess the latest unanswered text and, when it chooses to reply, sends Ali’s answer from that number. Later texts in the active chat can receive replies. **Pause** or **Take over** stops new automated replies. The officer composer in the portal is simulated. Use the phone or WhatsApp Web for manual sends.

## Connect the same number

1. On your phone, open **WhatsApp Business** with the number you also use on Telegram. If you use regular WhatsApp, back up your chats and move the existing number to WhatsApp Business. Telegram has its own connection. [WhatsApp's account move guide](https://faq.whatsapp.com/3059780464322392/)
2. In YCloud, choose **Connect WhatsApp Business App** and follow Meta's signup for the existing account. Confirm the same number on your phone. Meta checks eligibility during signup. You can decline to share earlier chats. Onboarding unlinks companion devices. Re-link **WhatsApp Web** to use the PC. WhatsApp for Windows is unsupported with Coexistence. [YCloud signup guide](https://www.ycloud.com/blog/whatsapp-business-app-coexistence-meta-update) · [Meta onboarding guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)
3. For this personally operated demo, tell each tester that YCloud and Meta handle messages for this number, Mirsad stores their demo texts, and Dispatch sends the conversation to Gemini through OpenRouter. Enroll their test number once they agree. Meta restricts use of its Business Platform by law enforcement agencies. [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy)

## Configure the PC

In the private project `.env`, fill in the following settings. The matching entries in `.env.example` contain no credentials.

| Setting | Value |
| --- | --- |
| `WHATSAPP_PROVIDER` | Set to `ycloud` for a YCloud connection. The default `meta` uses direct Graph API access. |
| `WHATSAPP_DEMO_TESTERS` | Comma-separated enrolled phone numbers, including country codes. |
| `WHATSAPP_DEMO_OFFICER_ID` | The portal owner's principal ID. The authenticated `GET /v1/me` returns it under `data.principal.id`. |
| `OPENROUTER_API_KEY` | Your existing OpenRouter key. The demo selects `google/gemini-3.8-flash`. |
| `WHATSAPP_WEBHOOK_PORT` | Default `8788`, reserved for the callback listener on `127.0.0.1`. |

Forward a public HTTPS callback to **`http://127.0.0.1:8788/webhooks/whatsapp`**. Expose only that listener. The officer portal stays on loopback port 8787. Disable request body and query-string logging on the proxy.

### YCloud

Once the number is connected, enter these four values in the private `.env`.

| Setting | Value |
| --- | --- |
| `YCLOUD_WABA_ID` | The numeric WhatsApp Business Account ID for the enrolled number. |
| `YCLOUD_BUSINESS_NUMBER` | That exact sender number in E.164 format, including the initial `+` and country code. |
| `YCLOUD_API_KEY` | A YCloud API key authorized to send WhatsApp messages for the number. |
| `YCLOUD_WEBHOOK_SECRET` | The signing secret for Mirsad's specific YCloud webhook endpoint. |

In **YCloud Dashboard → Developers → Webhooks**, add the public callback URL and register `whatsapp.inbound_message.received` and `whatsapp.smb.message.echoes`. These events cover new tester texts and manual replies from the WhatsApp Business app. Use the endpoint's signing secret in Mirsad. The listener checks each signature, the business account, the sender number, and the tester before recording a chat. [YCloud webhook setup](https://nndocs.ycloud.com/reference/configure-webhooks) · [YCloud event types](https://nndocs.ycloud.com/reference/webhook-events-payloads)

### Direct Meta Cloud API

For an account with direct Graph API access, use `WHATSAPP_PROVIDER=meta`. Set `WHATSAPP_PHONE_NUMBER_ID` to the numeric sender ID, provide `WHATSAPP_ACCESS_TOKEN` with `whatsapp_business_messaging` permission and use your Meta app's signing secret as `WHATSAPP_APP_SECRET`. Set `WHATSAPP_VERIFY_TOKEN` to a private random value and enter it in Meta's callback setup. The default `WHATSAPP_GRAPH_VERSION` is `v27.0`. Subscribe the sender's account to `messages` and `smb_message_echoes`. [Meta webhook setup](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/) · [Manual message echoes](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes/)

### Start the connector

Set `WHATSAPP_DEMO_ENABLED=true` once the provider settings are ready, then restart Mirsad from the project directory. Its existing Telegram workers also resume at startup. The signed-in demo owner can check `GET /v1/status` for `channels.whatsapp.status`. The value `demo_listening` means the local callback is running. Delivery of a signed webhook verifies the public connection.

## Run the demo

1. Ask an enrolled tester to send a fresh one-to-one text **after** the number is connected. They should use their phone or WhatsApp Web. Meta documents that messages sent from unsupported companion clients can miss webhooks.
2. Select their WhatsApp conversation in Mirsad and confirm **Dispatch**. Look in the timeline for the outcome. A successful API response means Meta accepted the reply. Check the tester’s device to verify delivery. Free-form replies use the 24-hour customer service window. [Meta's customer service window](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/#customer-service-window)
3. **Pause** the chat before taking a turn on the phone. A tester can send **STOP** to withdraw. Setting `WHATSAPP_DEMO_ENABLED=false` and restarting disables the connector for the whole demo.

The demo handles new individual text messages from enrolled numbers. Attachments, groups, edits, deletions, receipts, historical sync and contacts identified only by a hidden phone number are outside its scope. Use fictional conversation content for the demonstration.
