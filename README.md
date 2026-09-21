# Skipy Browser

macOS-re készült, Electron alapú böngésző első verziója.

## Indítás

Node.js és npm szükséges. A Terminalban, a projekt mappájából:

```sh
npm install
npm start
```

Az `npm.cmd run build` elkészíti a programot, az `npm.cmd run check` ellenőrzi a TypeScript kódot. A `start` előbb épít, majd elindítja az Electront. A böngészőprofil az Electron alkalmazásadat-könyvtárába kerül.

## macOS telepítő

```sh
npm run dist:mac
```

A build Intel és Apple Silicon gépekhez is elkészíti a `.dmg` telepítőket a `release/Skipy-Browser-0.1.0-x64.dmg` és `release/Skipy-Browser-0.1.0-arm64.dmg` fájlokban. Nyisd meg a saját gépedhez való DMG-t, majd húzd a Skipy Browser ikont az Applications mappába. A helyi profil a `~/Library/Application Support/skipy-browser/skipy-data` mappában marad. A telepítő nincs Apple által aláírva és hitelesítve, ezért az első indításkor a macOS figyelmeztetést jeleníthet meg.

## Használat

A címsor webcímeket nyit meg, más szövegre Google-keresést indít. Induláskor és új lap megnyitásakor rögtön a címsor kap fókuszt. A címsor másolásgombja az aktív HTTP(S)-oldal linkjét a vágólapra teszi. A `⌘T` új lapot nyit, a `⌘W` bezárja az aktív lapot, a `⌘L` kijelöli a címsort. Az `⌥+Balra` és `⌥+Jobbra` a lap előzményeiben lépked. A lapfül középső egérgombbal is bezárható; az utolsó lap bezárása kilép a böngészőből. Az `F12` vagy `⌘⇧I` külön ablakban nyitja és zárja az aktív oldal fejlesztői eszközeit.

A címsori keresési és előzményjavaslatok külön lebegő rétegen jelennek meg a weboldal fölött, ezért gépelés közben nem mozdítják el és nem méretezik át az oldalt.

A címsor melletti csillaggal az aktuális oldal könyvjelzőként menthető vagy eltávolítható. A jobb oldali gombokkal nyithatók meg a weboldal fölé csúszó panelek. Az előzményeknél egyetlen bejegyzés és a teljes lista is törölhető. A letöltések a macOS Letöltések mappájába kerülnek. Indításukkor az ikon felé repülő jelzés látszik, és megnyílik a letöltések lebegő ablaka. Ebben a futás közben indult letöltések megszakíthatók, a kész fájl megmutatható a Finderben. Az ablak az ikonról újranyitható; a listából eltávolítás nem törli a fájlt.

A lapfüleken, a könyvjelzőkben és az előzményekben a weboldal ikonja jelenik meg, ha az oldal megad egy favicon URL-t. A fogaskerék gombbal nyitható beállításpanelen Google, DuckDuckGo vagy Bing választható keresőnek. Ugyanitt a Skipy kezdőlap helyett egy teljes `http://` vagy `https://` webcím állítható be; az új lap és a Home gomb ezt nyitja meg.

A címsori biztonsági ikon az aktív oldal HTTPS-tanúsítványának elérhető adatait mutatja, vagy jelzi a kapcsolat hibáját. A felső sáv Bass Booster gombjával Tiszta, Mély és Erős preset, valamint 0–12 dB erősség és 60–160 Hz basszusfrekvencia állítható be a böngésző összes lapjára. A 0 dB kikapcsolja a feldolgozást; a beállítás az alkalmazás bezárásáig marad meg.

A weboldalon jobb kattintással linkek, képek és médiák nyithatók meg vagy tölthetők le, kijelölt szöveg kereshető, az oldal pedig teljes HTML-változatban menthető. Minden webes letöltés először egy Skipy megerősítő ablakban jelenik meg; csak a Letöltés gomb után indul el és kerül be a letöltési listába.

A Beállítások **I am a developer** kapcsolója engedélyezi az SDT-t. Ezután a felső sáv kódikonjával vagy `⌘⇧D`-vel nyitható meg a lebegő panel. A színválasztó az aktív oldal egy elemének háttér-, szöveg- és keretszínét mutatja, az API-tesztelő pedig cookie-k átvétele nélkül futtat HTTP(S) kéréseket 20 másodperces és 1 MB-os korláttal. Az UI-tesztek kattintást, szövegbevitelt, várakozást és URL-ellenőrzést rögzítenek. Futtatáskor az első URL-lépés automatikusan megnyílik kezdőpontként, ezért nem kell előre megkeresni vagy megnyitni az oldalt. Egy teszt azonos webhelyen több útvonalon is folytatódhat; az útvonalváltás automatikusan bekerül a lépések közé. A tesztek webhelyenként menthetők, legfeljebb 50 teszt és tesztenként 100 lépés erejéig. Jelszómező értéke nem kerül a felvételbe. Az `F12` és a `⌘⇧I` továbbra is a Chromium DevTools külön ablakát kezeli.

Az Adatvédelem panel webhelyenként, célhost szerint összesíti a hálózati kéréseket. Egy host letiltható és később feloldható. Az összesített napló újraindítás után is megmarad, de teljes URL-t nem tárol; webhelyenként vagy teljesen törölhető. A tiltási szabályokat a napló törlése nem érinti.

A Canvas és WebGL ujjlenyomat-mérések védelme alapból aktív, és webhelyenként kikapcsolható. A módosított értékek ugyanazon webhelyen állandók, más webhelyen eltérnek. A panel jelzi, ha a védelem nem tudott elindulni. Ez a védelem nem biztosít teljes anonimitást: más böngészőjellemzőket és a hálózati címet nem módosítja.

Az `F11` a böngészőt teljes képernyőre teszi, ismételt `F11` vagy `Esc` visszalép. A weboldalak videóinak teljes képernyős módja külön működik; kilépés után a korábbi böngészőnézet áll vissza. Az alkalmazás hibái és fontos műveletei rövid értesítésként jelennek meg alul, középen.
