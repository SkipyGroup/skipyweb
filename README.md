# Skipy Browser

Windowsra készült, Electron alapú böngésző első verziója.

## Indítás

Node.js és npm szükséges. PowerShellben, a projekt mappájából:

```powershell
npm.cmd install
npm.cmd start
```

Az `npm.cmd run build` elkészíti a programot, az `npm.cmd run check` ellenőrzi a TypeScript kódot. A `start` előbb épít, majd elindítja az Electront. A böngészőprofil az Electron alkalmazásadat-könyvtárába kerül.

## Használat

A címsor webcímeket nyit meg, más szövegre Google-keresést indít. A `Ctrl+T` új lapot nyit, a `Ctrl+W` bezárja az aktív lapot, a `Ctrl+L` kijelöli a címsort. Az `Alt+Balra` és `Alt+Jobbra` a lap előzményeiben lépked.

A címsor melletti csillaggal az aktuális oldal könyvjelzőként menthető vagy eltávolítható. A jobb oldali gombokkal nyithatók meg a weboldal fölé csúszó panelek. Az előzményeknél egyetlen bejegyzés és a teljes lista is törölhető. A letöltések a Windows Letöltések mappájába kerülnek. Indításukkor az ikon felé repülő jelzés látszik, és megnyílik a letöltések lebegő ablaka. Ebben a futás közben indult letöltések megszakíthatók, a kész fájl megmutatható a Fájlkezelőben. Az ablak az ikonról újranyitható; a listából eltávolítás nem törli a fájlt.

A lapfüleken, a könyvjelzőkben és az előzményekben a weboldal ikonja jelenik meg, ha az oldal megad egy favicon URL-t. A fogaskerék gombbal nyitható beállításpanelen Google, DuckDuckGo vagy Bing választható keresőnek. Ugyanitt a Skipy kezdőlap helyett egy teljes `http://` vagy `https://` webcím állítható be; az új lap és a Home gomb ezt nyitja meg.

A címsori biztonsági ikon az aktív oldal HTTPS-tanúsítványának elérhető adatait mutatja, vagy jelzi a kapcsolat hibáját. A felső sáv Bass Booster gombjával laponként 0–12 dB mélyhangkiemelés állítható be. A 0 dB kikapcsolja a feldolgozást; a beállítás a lap bezárásáig marad meg. Ha a hangrögzítés nem indul el, a böngésző visszaállítja a normál hangot.

Az Adatvédelem panel webhelyenként, célhost szerint összesíti a hálózati kéréseket. Egy host letiltható és később feloldható. Az összesített napló újraindítás után is megmarad, de teljes URL-t nem tárol; webhelyenként vagy teljesen törölhető. A tiltási szabályokat a napló törlése nem érinti.

A Canvas és WebGL ujjlenyomat-mérések védelme alapból aktív, és webhelyenként kikapcsolható. A módosított értékek ugyanazon webhelyen állandók, más webhelyen eltérnek. A panel jelzi, ha a védelem nem tudott elindulni. Ez a védelem nem biztosít teljes anonimitást: más böngészőjellemzőket és a hálózati címet nem módosítja.

Az `F11` a böngészőt teljes képernyőre teszi, ismételt `F11` vagy `Esc` visszalép. A weboldalak videóinak teljes képernyős módja külön működik; kilépés után a korábbi böngészőnézet áll vissza. Az alkalmazás hibái és fontos műveletei rövid értesítésként jelennek meg alul, középen.
