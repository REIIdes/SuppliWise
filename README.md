# SuppliWise — Personal na Gabay sa Kalusugan at Supplements

Ang **SuppliWise** ay isang full-stack na web application para sa pagtatasa ng kalusugan, personalisadong gabay sa supplements, pagsubaybay sa araw-araw na intake, at pakikipag-ugnayan sa support team. May hiwalay itong admin console, subscription system, mga panseguridad na kontrol, PWA at Android app.

> Ang mga rekomendasyon ay para sa pangkalahatang gabay sa kalusugan at hindi kapalit ng pagsusuri, payo, o paggamot mula sa lisensiyadong propesyonal sa kalusugan.

## Nilalaman

- [Tungkol sa system](#tungkol-sa-system)
- [Mga pangunahing feature](#mga-pangunahing-feature)
- [Mga pagbabago sa Main-2](#mga-pagbabago-sa-main-2)
- [End-to-end encryption sa support chat](#end-to-end-encryption-sa-support-chat)
- [Teknolohiya](#teknolohiya)
- [Mga kailangan bago mag-install](#mga-kailangan-bago-mag-install)
- [Pag-install at pagpapatakbo](#pag-install-at-pagpapatakbo)
- [Mga test at pagsusuri](#mga-test-at-pagsusuri)
- [Mahahalagang API](#mahahalagang-api)
- [Ayos ng repository](#ayos-ng-repository)
- [Iba pang dokumentasyon](#iba-pang-dokumentasyon)
- [Mahalagang paalala sa seguridad](#mahalagang-paalala-sa-seguridad)

## Tungkol sa system

Binubuo ang SuppliWise ng React web client at Node.js/Express API na gumagamit ng MongoDB. Nagsa-save ito ng mga health assessment, supplement plan, intake history, support conversations, account settings, subscription request, at iba pang datos ng system.

May dalawang magkahiwalay na chat:

1. **AI Chat Assistant** — para sa mga tanong tungkol sa kalusugan, nutrisyon, supplements, at SuppliWise. Nakadepende sa configuration at availability ng mga AI provider; may fallback para sa ilang feature.
2. **Support Chat** — pribadong conversation sa support team na makikita sa member inbox at admin console. Ito ang chat na gumagamit ng end-to-end encryption.

Ang blockchain feature ay isang **simulated, self-contained proof-of-work ledger** sa loob ng application. Hindi ito konektado sa pampublikong blockchain, at hindi kailangan ng crypto wallet, gas, o external RPC node para patakbuhin ang system. MongoDB pa rin ang pangunahing data store.

## Mga pangunahing feature

### Health assessment at personalisadong gabay

- Multi-step na assessment para sa profile, diet, layunin, kondisyon, sintomas, lifestyle, gamot, allergy, at supplements.
- Mga rekomendasyon sa supplements na nakaayos ayon sa priyoridad, kasama ang dosage, oras ng pag-inom, babala, at mga sangguniang siyentipiko kung available.
- Mga mungkahi sa pagkain at lifestyle na isinasaalang-alang ang mga iniulat na kondisyon, layunin, diet, at allergy.
- Kasaysayan ng assessment at pag-export ng ulat bilang PDF.
- May mga paalala para humingi ng tulong sa propesyonal kung kailangan.

### Dashboard at pagsubaybay

- Araw-araw na supplement plan at pagtatala kung nainom na ang bawat item.
- Pagsubaybay sa adherence, streak, progreso, at wellness metrics.
- Pagpapatuloy ng tracking kapag ina-update ang assessment, kung sinusuportahan ng kaugnay na daloy.

### Account, subscription, at admin

- Mga antas ng Free, Deluxe, Premium, at Ultimate; sa server ipinapatupad ang access sa mga feature.
- Mga subscription request at pagkansela na sinusuri ng admin.
- Hiwalay na admin console para sa pamamahala ng account, assessment, subscription, support chats, at security monitoring.
- Mga account-security feature gaya ng passkeys, authenticator codes, email verification, recovery codes, session management, at muling pagpapatunay para sa sensitibong aksyon.
- In-app notifications para sa mga update at aktibidad ng account.

### PWA, Android, at Web3

- Maaaring i-install bilang Progressive Web App; mayroon ding Android project na gumagamit ng Capacitor.
- Kasama sa Web3 area ang mga demo ng supply-chain tracking, verification, marketplace, staking, rewards, at governance.
- Ang mga on-chain na konsepto rito ay pinapatakbo ng sariling simulated ledger ng application; huwag ipagkamali ito sa live public blockchain.

## Mga pagbabago sa Main-2

Ang mga sumusunod ay kabilang sa mga pagbabagong nasa `Main-2`, kabilang ang mga suportang feature na naidagdag sa branch:

- **Support chat na may end-to-end encryption (E2EE):** naka-encrypt sa browser ang mga mensahe bago ipadala sa server.
- **Bagong conversation at legacy conversation:** kailangang naka-encrypt ang bagong support conversation. Sinusubukang i-seal ang mga lumang plaintext conversation kapag binuksan at may sapat na susi; hindi ito nangangahulugang sabay-sabay na bulk migration ng lahat ng lumang chat.
- **Recovery para sa chat key:** maaaring gumawa at gumamit ng recovery code para maibalik sa browser ang identity key sa ibang device.
- **Paglalathala ng admin public key:** nagsisimula ang key setup kapag naka-sign in ang admin sa dashboard. Awtomatikong muling sinusuri ng member client ang support key directory kapag wala pang naka-publish na support key.
- **Pagbabahagi ng conversation key:** ibinabahagi ang key sa mga awtorisadong participant ng thread upang mabasa nila ang mensahe.
- **Pagpapahusay sa support inbox:** kasama sa branch ang mga update sa chat UI, notification at key-sharing flow, pati na ang suporta sa profile image at GIF sa conversation.
- **Visual refresh:** inilapat ang mas pare-parehong emerald, teal, at indigo na kulay gamit ang design tokens sa maraming screen at component.

> Ang README na ito ay naglalarawan sa mga pagbabago ng `Main-2` na na-commit sa branch. Maaaring may hindi pa committed na lokal na pagbabago sa working copy na hindi bahagi ng branch commit.

## End-to-end encryption sa support chat

### Paano gumagana

1. Gumagawa ang browser ng identity key para sa account at iniimbak nang lokal ang pribadong bahagi nito.
2. May hiwalay na conversation key ang bawat support thread. Sa browser ine-encrypt ang mensahe gamit ang AES-256-GCM.
3. Binabalot ang conversation key para sa public key ng member at sa public key ng mga awtorisadong support admin. Ang server ay nag-iimbak ng encrypted message at key shares, hindi ng pribadong identity keys.
4. Sa device na may wastong pribadong identity key lamang mabubuksan ang key share at mada-decrypt ang mensahe.
5. Maaaring balutin ng recovery code ang pribadong identity key para maibalik ito ng may-ari ng account. Sa restore, inilalagay ang code sa browser; hindi dapat ipadala o ibigay ito sa support.

### Mahalagang limitasyon at paalala

- **Walang iisang global private decryption key para sa admin.** Bawat admin account ay may sariling key pair. Nababasa lang ng admin ang thread kung naibahagi sa kanyang public key ang conversation key.
- Kapag nawala ang pribadong identity key at wala ang recovery code, maaaring hindi na mabuksan ang mga lumang encrypted message sa bagong device.
- Kapag walang available na support public key, pinipigil ang paggawa/pagpapadala ng bagong chat na hindi naka-encrypt. Maghintay hanggang makapag-publish ng key ang admin.
- Hindi kayang basahin ng server ang encrypted na mensahe, pero hindi nito awtomatikong ine-encrypt ang mga lumang plaintext backup o kopyang dati nang na-export sa labas ng system.
- Ang encryption ay para sa support chat lamang; hindi ito paglalarawan ng encryption ng AI Chat Assistant.

## Teknolohiya

| Bahagi | Teknolohiya |
|---|---|
| Frontend | React 18, Vite 8, React Router |
| Backend | Node.js 18 pataas, Express 4 |
| Database | MongoDB at Mongoose |
| Mobile | PWA at Capacitor para sa Android |
| Pagpapatunay | JWT, session validation, WebAuthn/passkeys, TOTP at recovery flow |
| AI | Mga provider na kino-configure sa server at mga fallback kung naaangkop |
| Chat encryption | Web Crypto API, AES-256-GCM, public-key wrapping at lokal na pribadong susi |
| Web3 demo | Sariling append-only proof-of-work ledger |
| Pagsusuri | Node.js test runner at ESLint |

## Mga kailangan bago mag-install

- Node.js **18 o mas bago**
- MongoDB na tumatakbo at naaabot ng backend
- Mga API credential para sa mga AI/email feature na nais patakbuhin
- JDK 17 at Android SDK kung gagawa ng Android APK

## Pag-install at pagpapatakbo

### 1. Kunin ang repository at i-install ang backend

```powershell
git clone https://github.com/REIIdes/SuppliWise.git
Set-Location SuppliWise
Set-Location server
npm install
Copy-Item .env.example .env
```

Buksan ang `server/.env` sa lokal na development environment at ilagay ang sariling MongoDB connection string at mga kinakailangang secret/API credential. **Huwag i-commit o ibahagi ang `.env` file.** Tingnan ang `server/.env.example` para sa mga pangalan at paliwanag ng configuration variable.

### 2. I-install ang frontend

Sa hiwalay na terminal, mula sa root ng repository:

```powershell
Set-Location my-react-app
npm install
```

### 3. Simulan ang application

Sa isang terminal:

```powershell
Set-Location server
npm run dev
```

Sa ikalawang terminal:

```powershell
Set-Location my-react-app
npm run dev
```

Buksan ang development address na ipinakita ng Vite sa terminal. Kung gagamit ng secure context feature gaya ng passkeys o E2EE sa ibang device, tiyaking tugma ang HTTPS/TLS configuration ng frontend at backend. Sundin ang lokal na development certificate setup ng proyekto kung kinakailangan.

### Production build ng frontend

```powershell
Set-Location my-react-app
npm run build
```

### Android APK

Kailangan ang Android SDK, Gradle/Capacitor at JDK 17. Mula sa `my-react-app`:

```powershell
npm run build
npx cap sync android
Set-Location android
.\gradlew.bat assembleDebug
```

Karaniwang output: `my-react-app/android/app/build/outputs/apk/debug/SuppliWise.apk`. Suriin ang kasalukuyang Android build configuration kung may pagbabago sa kinakailangang Java version.

## Mga test at pagsusuri

Frontend:

```powershell
Set-Location my-react-app
npm test
npm exec eslint -- src/Pages/AdminDashboard.jsx src/Components/AdminSupportChats/AdminSupportChats.jsx src/security/useSecureChat.js
npm run build
```

Backend:

```powershell
Set-Location server
npm test
npm run check
```

May environment-gated test ang ilang integration flow; maaaring kailanganin ang test database o development configuration para maisagawa ang mga ito. Huwag gumamit ng production credential o data sa test.

## Mahahalagang API

Nasa ilalim ng `/api` ang mga route. Kabilang sa pangunahing grupo ang:

| Gamit | Path |
|---|---|
| Pag-login, registration at account | `/api/auth` |
| Passkeys | `/api/auth/passkeys` |
| TOTP | `/api/auth/totp` |
| Recovery codes | `/api/auth/recovery-codes` |
| Health assessment | `/api/assessment` |
| Recommendations at AI chat | `/api/recommend`, `/api/chat` |
| Member support chat at encryption keys | `/api/support-chat` |
| Subscription at plan | `/api/subscription` |
| Dashboard at insights | `/api/dashboard`, `/api/insights` |
| Notifications | `/api/notifications` |
| Admin at admin support chat | `/api/admin`, `/api/admin/chats` |
| Web3 | `/api/web3` |

Ang authentication at access control ay nakadepende sa bawat route. Huwag ipagpalagay na pampubliko ang API dahil lamang sa nakalista ito rito.

## Ayos ng repository

```text
SuppliWise/
├── server/
│   ├── models/       # Mongoose data model
│   ├── routes/       # API endpoint
│   ├── middleware/   # Authentication at access control
│   ├── utils/        # Encryption, subscription, session at AI utilities
│   ├── blockchain/   # Simulated ledger at Web3 logic
│   └── Test File/    # Backend tests
└── my-react-app/
    ├── src/Pages/    # Member at admin screens
    ├── src/Components/ # Reusable UI, support chat at security panels
    ├── src/security/ # Chat key management at encryption
    └── android/      # Capacitor Android project
```

## Iba pang dokumentasyon

- [System Architecture](SYSTEM_ARCHITECTURE.md) — kabuuang arkitektura ng application.
- [E2E Encryption Guide](E2E_ENCRYPTION_COMPLETE.md) — dokumentasyon at tala tungkol sa support-chat encryption.
- [Gabay sa E2E Encryption Testing](E2E_ENCRYPTION_TEST_GUIDE.md) — mga pagsusuri para sa encrypted chat.
- [Blockchain Feature Map](BLOCKCHAIN_FEATURES.md) — mga Web3 feature at katumbas na source/test.
- [User Manual para sa Web3](docs/USER_MANUAL.md) — gabay para sa mga user.
- [Developer Manual para sa Web3](docs/DEVELOPER_MANUAL.md) — gabay para sa mga developer.
- [Developer Guide sa Session Architecture](docs/DEVELOPER_GUIDE.md) — session, route guard at error handling.
- [Gabay sa maraming account](docs/USER_GUIDE.md) — account at saved-login workflow.
- [Admin Setup](ADMIN_SETUP.md) — pag-configure ng admin account.

## Mahalagang paalala sa seguridad

- Huwag ilagay ang tunay na API key, password, TOTP secret, recovery code, o pribadong encryption key sa source code, README, issue, o chat.
- Huwag i-commit ang `server/.env`; gamitin ang `.env.example` bilang template lamang.
- Huwag magpadala sa support ng recovery code o pribadong chat key.
- I-test ang E2EE sa dalawang magkaibang account/browser at tiyaking nailathala ang admin public key bago gumawa ng bagong support conversation.
- I-deploy lamang pagkatapos mapatakbo ang naaangkop na test, lint, at production build para sa mga binagong bahagi.
