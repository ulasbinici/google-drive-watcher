# Drive Watch kurulumu

Masaüstü uygulama Tauri 2 ve Svelte 5 ile çalışır. Google hesap bağlantısı, Drive klasör izleme ve webhook kanalı Firebase Functions üzerinden yönetilir. Seçilen klasörlerin alt klasörleri de izlenir; kapsam My Drive ve Shared Drives’tır.

English: [setup.md](setup.md).

## Google Cloud

1. Bir Google Cloud projesi açın ve Google Drive API’yi etkinleştirin.
2. OAuth consent screen’i oluşturun. Uygulama harici ise, doğrulanana kadar test kullanıcılarını ekleyin.
3. Desktop veya Web istemcisi oluşturun. Yetkili yönlendirme URI’si şudur:

   `https://us-central1-PROJECT_ID.cloudfunctions.net/oauthCallback`

4. İstenen kapsam `https://www.googleapis.com/auth/drive.metadata.readonly` ile OpenID profil kapsamlarıdır. Bu kapsam hassas olduğu için uygulamanın herkese açık yayını Google doğrulaması gerektirebilir. Doğrulama tamamlanana kadar yalnız test kullanıcıları bağlanabilir.

## Firebase

1. Aynı Google Cloud projesine Firebase ekleyin.
2. Authentication içinde Google sağlayıcısını değil, uygulamanın ürettiği custom token akışını kullanın. Authentication’ın etkin olması yeterlidir.
3. Firestore’u Native modda oluşturun.
4. `firebase login` sonrası `.firebaserc.example` dosyasını `.firebaserc` olarak kopyalayıp proje kimliğini yazın.
5. Secret’ları tanımlayın:

```bash
firebase functions:secrets:set GOOGLE_CLIENT_ID
firebase functions:secrets:set GOOGLE_CLIENT_SECRET
firebase functions:secrets:set TOKEN_ENCRYPTION_KEY
```

`TOKEN_ENCRYPTION_KEY`, 32 baytlık rastgele bir anahtarın base64 karşılığıdır:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

6. `functions/.env` içine `PUBLIC_BASE_URL` değerini function kök URL’si olarak yazın. Örnek değer `functions/.env.example` dosyasındadır. `DESKTOP_REDIRECT_SCHEME` varsayılanı `drivewatch://oauth/callback` şeklindedir.
7. Kuralları, indexleri ve function’ları yayınlayın:

```bash
pnpm --filter @drive-watch/functions build
firebase deploy --only functions,firestore
```

`renewDriveChannels` altı saatte bir çalışır ve süresi 36 saatten az kalmış Drive kanallarını yeniler. Drive `changes` kanalları en fazla bir hafta yaşar. `cleanupEphemeralAuth` süresi dolmuş OAuth kayıtlarını siler.

## Masaüstü

Kökte bağımlılıkları kurun:

```bash
pnpm install
```

`apps/desktop/.env` dosyasını `.env.example` üzerinden oluşturun. `PUBLIC_FUNCTIONS_BASE_URL`, Firebase function kökünü göstermelidir; sonda eğik çizgi olmamalıdır. Bu değişkenler boşsa uygulama yerel demo verisiyle açılır.

Geliştirme:

```bash
pnpm dev:desktop
```

Üretim paketleri:

```bash
pnpm --filter @drive-watch/desktop tauri build
```

- Windows paketleri NSIS veya MSI olarak üretilir. `drivewatch://` şeması kurulumla kaydedilir.
- macOS paketleri `.app` ve `.dmg` üretir. İlk çalıştırmada bildirim izni istenir.
- Linux paketleri webkit2gtk ve `xdg-desktop-menu` bulunan bir sistemde AppImage, deb veya rpm olarak üretilir. Deep link kaydı `update-desktop-database` gerektirir.

Pencere kapatılınca uygulama sistem tepsisinde çalışmaya devam eder. Sol tıklama pencereyi açar. Menüden izleme duraklatılır, sürdürülebilir veya uygulama kapatılır.

## Yerel doğrulama

```bash
pnpm --filter @drive-watch/functions test
pnpm --filter @drive-watch/functions check
pnpm --filter @drive-watch/desktop check
pnpm --filter @drive-watch/desktop build
```

Firestore ve Functions emülatörü Java gerektirir:

```bash
pnpm emulators
```

OAuth dışındaki kural ve webhook akışı emülatörde denenebilir. Drive istemcisi üretimde Google API’ye gider; otomatik testler klasör soy ağacı, değişiklik türü, sayfa imleci, tekrarlanan webhook ve kanal yenilemesini yerelde doğrular.

## Kabul akışı

1. Uygulamadan Google hesabına bağlanın ve tarayıcıdaki izni onaylayın.
2. My Drive veya bir Shared Drive klasörü seçip kaydedin.
3. Seçilen klasörün bir alt klasöründe dosya oluşturun, düzenleyin, taşıyın ve silin.
4. Birkaç saniye içinde Firestore bildirimi ve tepsi bildirimi gelmelidir.
5. Uygulamayı kapatıp tepside açık bırakın, yeniden açın ve hesabın durduğunu doğrulayın.
6. İzlemeyi duraklatın; duraklama sırasında bildirim gelmemeli. Sürdürdüğünüzde bekleyen değişiklikler işlenmelidir.
