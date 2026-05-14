export interface RawTutorContact {
  name: string;
  phoneNumber?: string;
  email?: string;
}

export interface DefaultTutorContact {
  canonicalKey: string;
  displayName: string;
  onsiteEmail: string | null;
  onlineEmail: string | null;
  onsitePhone: string | null;
  onlinePhone: string | null;
  sourceNames: string[];
}

export const DEFAULT_CONTACT_ALIASES = new Map<string, string>([
  ["kev", "Kevin"],
  ["paoju", "Paojuu"],
  ["poi", "Nacha (Poi)"],
  ["sam", "Samantha"],
]);

export const RAW_TUTOR_CONTACTS: RawTutorContact[] = [
  { name: "Kemjira (Kem) Waritpariya", email: "k.waritpariya@gmail.com" },
  { name: "Kieran (Key) Wilkinson Online", email: "kieran.wilkinson14@yahoo.co.uk" },
  { name: "Kieran (Key) Wilkinson", phoneNumber: "66612977925", email: "wilkinson.kj917@gmail.com" },
  { name: "Rasna (Ras) Rajkitkul", email: "rajkitkulrasna@gmail.com" },
  { name: "Rasna (Ras) Rajkitkul Online", phoneNumber: "66632183047", email: "rrajkitkul@gmail.com" },
  { name: "Anavat (A) Siamwala Online", email: "a34074145@gmail.com" },
  { name: "Bordin (Win-Bordin) Tanasubchusri Online", email: "win1winny2@gmail.com" },
  { name: "Bordin (Win-Bordin) Tanasubchusri", phoneNumber: "66621042390", email: "winwinny21@gmail.com" },
  { name: "Anavat (A) Siamwala", phoneNumber: "66876981221", email: "anavat10@gmail.com" },
  { name: "Wanwisa (Gift) Montrikittiphant Online", email: "gift.m@begiftededucation.com" },
  { name: "Tudda (Da) Tudsirivoravat", phoneNumber: "66832459245", email: "tudda.tudsirivoravat@gmail.com" },
  { name: "Suphawisit (Fluke-Supha) Boonla Online", email: "suphawisit19972540@gmail.com" },
  { name: "Suphawisit (Fluke-Supha) Boonla", phoneNumber: "66942598949", email: "suphawisit.boo@gmail.com" },
  { name: "Thanit (Mimi) Montrikittiphant Online", email: "mimitutor15@gmail.com" },
  { name: "Natchasmith (Earng) Rueangchan", phoneNumber: "66933299429", email: "aoengnatchasmith@gmail.com" },
  { name: "Kevin (Kev) Y. Hsieh", phoneNumber: "66994524777", email: "kevhsh7@gmail.com" },
  { name: "Samantha (Sam) Nicole Beattie Online", email: "samantha.nicole.beattie@gmail.com" },
  { name: "Samantha (Sam) Nicole Beattie", phoneNumber: "66910181506", email: "krusamtutor@gmail.com" },
  { name: "Chettaporn (Fluke) Chuesuphan Online", email: "flukresist@gmail.com" },
  { name: "Chettaporn (Fluke) Chuesuphan", phoneNumber: "66979194239", email: "chettaporn.chu@gmail.com" },
  { name: "Pariwat (Punlee) Leelaaburanapong Online", email: "6870037238@student.chula.ac.th" },
  { name: "Pariwat (Punlee) Leelaaburanapong", phoneNumber: "66929514961", email: "pariwatlee@gmail.com" },
  { name: "Veerawin (Win) Su Online", email: "winnsmiles@gmail.com" },
  { name: "Veerawin (Win) Su", phoneNumber: "66836083069", email: "vwinsu@gmail.com" },
  { name: "Tarathip (Jan) Tangkanjanapas Online", email: "tarathip.tan@gmail.com" },
  { name: "Tarathip (Jan) Tangkanjanapas", phoneNumber: "66839169598", email: "tarathip.ph@gmail.com" },
  { name: "Kittiya (Care) Taweesinprasarn", email: "kittiya.carekt@gmail.com" },
  { name: "Pakwalan (Aya) Singkhorn", phoneNumber: "66801653558", email: "pakwalaan@gmail.com" },
  { name: "Roger (Roger) Tang Online", email: "rogerhtang@yahoo.com" },
  { name: "Roger (Roger) Tang", phoneNumber: "66808358552", email: "rogerhtang@gmail.com" },
  { name: "Jennie (Jennie) Williams Online", email: "divingjunkie69@gmail.com" },
  { name: "Jennie (Jennie) Williams", phoneNumber: "447882702572", email: "jenniealex6774@gmail.com" },
  { name: "Wongsiri (Grace) Montrikittiphant Online", email: "grace.wongsiri@gmail.com" },
  { name: "Wongsiri (Grace) Montrikittiphant", phoneNumber: "66925965595", email: "wongsirimontrikittiphant@gmail.com" },
  { name: "Tutor Sandhya", phoneNumber: "919035629452" },
  { name: "Tavinie (Amy) Olarnsakul Online", email: "tavinie.olarnsakul@gmail.com" },
  { name: "Tavinie (Amy) Olarnsakul", phoneNumber: "66972400329", email: "amyx3ie@gmail.com" },
  { name: "Apivit (Ek) Sirithana Online", email: "apiwitake@hotmail.com" },
  { name: "Apivit (Ek) Sirithana", phoneNumber: "66914361324", email: "apivit.s@hotmail.com" },
  { name: "Wanwisa (Gift) Montrikittiphant", phoneNumber: "66926451564", email: "m.giftwan@gmail.com" },
  { name: "Suphitsara (Muk) Manosamrit", phoneNumber: "66935144254", email: "suphitsaramanosamrit@gmail.com" },
  { name: "Panida (Petchy) Wiya", phoneNumber: "66827619421", email: "panida.wiya@gmail.com" },
  { name: "Chiraya (Palm) Takornkulwut", phoneNumber: "66610290953", email: "chiraya.work@gmail.com" },
  { name: "Phungbudh (Phutta) Saprasert", phoneNumber: "66909453982", email: "puttynarak55@gmail.com" },
  { name: "Thanit (Mimi) Montrikittiphant", phoneNumber: "66961465654", email: "miieiiem@gmail.com" },
  { name: "Chanamon (Pearcha) Rattanapittayaporn Online", email: "chanamon.rattana@gmail.com" },
  { name: "Dolruethai (Glai) Rodma", phoneNumber: "66622741261", email: "dolruethai.r@gmail.com" },
  { name: "Ruke (Lukas) Ogan", phoneNumber: "66917587487", email: "rukeogan@gmail.com" },
  { name: "Sanpat (Copter) Chanthanuraks", phoneNumber: "66858130334", email: "sanpatchanthanuraks@gmail.com" },
  { name: "Nithi (Hansri) Tantivitayapitak", phoneNumber: "66898480017", email: "nithi.tanti@gmail.com" },
  { name: "Thandolkhawathn (June) Choochaisangrathn", phoneNumber: "66622796655", email: "thonnisorn.c@gmail.com" },
  { name: "Narongsak (Sagotty) Sriwiran Online", email: "sagotty.narongsaksri@gmail.com" },
  { name: "Thanyawat (Petch-Than) Phattharathitinan", phoneNumber: "66962363995", email: "thanyawat.arts@gmail.com" },
  { name: "Smit (Tito) Kanjanapas", phoneNumber: "66814233444", email: "drxiox@gmail.com" },
  { name: "Smit (Tito) Kanjanapas Online", email: "smit.kanjanapas@gmail.com" },
  { name: "Narongsak (Sagotty) Sriwiran", phoneNumber: "66641800132", email: "sagot.narongsaksri@gmail.com" },
  { name: "Wichaya (Praew) Peechapat", phoneNumber: "66805550119", email: "wichayapeechapat.work@gmail.com" },
  { name: "Supatin (Sand) Mankongvanichkul", phoneNumber: "66840888046", email: "m.supatin@gmail.com" },
  { name: "Chinnakrit (Celeste) Channiti", phoneNumber: "66800826271", email: "chinnakrit.channiti@gmail.com" },
  { name: "Pawin (Pawin) Chantaworakit", phoneNumber: "66804555676", email: "pawin307@hotmail.com" },
  { name: "Warit (Shop) Trikasemsak", phoneNumber: "66953697474", email: "warit.trk@gmail.com" },
  { name: "Kasidej (Peat) Jungrakangthong", phoneNumber: "66867929970", email: "kasidej.ju@gmail.com" },
  { name: "Pawin (Pawin) Chantaworakit Online", email: "pawin307@gmail.com" },
  { name: "Wichaya (Praew) Peechapat Online", email: "wichaya.p@st.econ.tu.ac.th" },
  { name: "Teeratarn (Prae-Tarn) Vipattipumiprathet", phoneNumber: "66626969655", email: "ms.prae@gmail.com" },
  { name: "Thossaporn (Sun) Thatsananutariyakul", phoneNumber: "66863198957", email: "solesun0@gmail.com" },
  { name: "Nonthawat (Rew) Lertprasitchok", phoneNumber: "66819051676", email: "nonthawat.lert@outlook.com" },
  { name: "Kasidej (Peat) Jungrakangthong Online", email: "peat_once@hotmail.com" },
  { name: "Vasinee (Prae) Chuenglertsiri Online", email: "vasinee.chuenglertsiri@gmail.com" },
  { name: "Nacha (Poi) Srinakarin Online", email: "nacha.poiu@gmail.com" },
  { name: "Kumpanat (Pech) Thongmai", phoneNumber: "66830602757", email: "kumpanat.ee@gmail.com" },
  { name: "Kumpanat (Pech) Thongmai Online", email: "kumpanat.tm@gmail.com" },
  { name: "Thanyawat (Petch-Than) Phattharathitinan Online", email: "thanyawat.cu@hotmail.com" },
  { name: "Phurit (Mookie) Bovornchutichai", phoneNumber: "66816264551", email: "phurit.bov@gmail.com" },
  { name: "Prohrak (Paoju) Kruengthomya", phoneNumber: "66632457740", email: "prohrakju@gmail.com" },
  { name: "Patcharida (Nan) Penpakkul Online", email: "sowonanpark@gmail.com" },
  { name: "Menika (Menika) Ratnakovit", phoneNumber: "66814456964", email: "menika1289@gmail.com" },
  { name: "Nithit (Nithit) Singhsachthep", phoneNumber: "66620320492", email: "nsinghsachthep@gmail.com" },
  { name: "Pornnapha (Mint) Montrikittiphant", phoneNumber: "66904242942", email: "mint.mpm@gmail.com" },
  { name: "Prohrak (Paoju) Kruengthomya Online", email: "paojubusiness@gmail.com" },
  { name: "Supatcha (Pakgad) Rod-em", phoneNumber: "66911198148", email: "pakgadpg@gmail.com" },
  { name: "Patcharida (Nan) Penpakkul", phoneNumber: "66881612546", email: "sowonanlee@gmail.com" },
  { name: "Pat (Pat) O'Corner Online", email: "noipatnoi@gmail.com" },
  { name: "Pat (Pat) O'Corner", phoneNumber: "66895262554", email: "noiandpat@gmail.com" },
  { name: "Jiranart (Nop) Vacheesuthum", phoneNumber: "66850990018", email: "jiranartv@gmail.com" },
  { name: "Supatcha (Pakgad) Rod-em Online", email: "anotherpaks@gmail.com" },
  { name: "Pornnapha (Mint) Montrikittiphant Online", email: "liuling.cll@gmail.com" },
  { name: "Kavin (Kavin) Diwan Singh", phoneNumber: "66894826545", email: "kavdsingh@gmail.com" },
  { name: "Phattadon (Eng) Sucharittanonta Online", email: "phattadon@gmail.com" },
  { name: "Mandy (Mandy) Boontanrart", phoneNumber: "66902961231", email: "boontanrart@gmail.com" },
  { name: "Chidchanok (Linn) Saetiaw", phoneNumber: "66967541834", email: "linnkub@hotmail.com" },
  { name: "Phattadon (Eng) Sucharittanonta", phoneNumber: "66826451996", email: "phattadon.work@gmail.com" },
  { name: "Porntawan (Lookpear) Maneechote", phoneNumber: "66830075511", email: "porntawan.mn@gmail.com" },
  { name: "Rachata (Mek) Sakpuaram", phoneNumber: "66840095143", email: "sakpuaram.rachata@gmail.com" },
  { name: "Ruke (Lukas) Ogan Online", email: "oganlukas@gmail.com" },
  { name: "Thandolkhawathn (June) Choochaisangrathn Online", email: "june.memory@gmail.com" },
  { name: "Tulya (Kristie) Tulyasuwan", phoneNumber: "66836495596", email: "kristietallye@gmail.com" },
  { name: "Susama (Fay) Kitiyakara Online", email: "s.faykiti@gmail.com" },
  { name: "Chidchanok (Linn) Saetiaw Online", email: "linnengineer193@gmail.com" },
  { name: "Kevin (Kev) Y. Hsieh Online", email: "kevinhsieh479@gmail.com" },
  { name: "Panithan (Fen) Sasiwimon Online", email: "nopickl9864@gmail.com" },
  { name: "Panithan (Fen) Sasiwimon", phoneNumber: "66928867019", email: "eccle5454@gmail.com" },
  { name: "Susama (Fay) Kitiyakara", phoneNumber: "66655041456", email: "faykitiyakara@gmail.com" },
  { name: "Raksilp (Euro) Chotemongkolkul", phoneNumber: "66924790943", email: "raksilp.cho@gmail.com" },
  { name: "Nithi (Hansri) Tantivitayapitak Online", email: "n.tantivitayapitak@gmail.com" },
  { name: "Calvin (Calvin) Lim Wen Quan", phoneNumber: "66804494624", email: "calvlim89@gmail.com" },
  { name: "Hassakol (Buzz) Panaspraipong", phoneNumber: "66926298243", email: "panaspraipong@gmail.com" },
  { name: "Usanee (Aey) Tortermpun", phoneNumber: "66617199449", email: "usanee.tor@gmail.com" },
  { name: "Photcharaphong (Aong) Rodmanee Online", email: "photcharaphong.r@gmail.com" },
  { name: "Tudda (Da) Tudsirivoravat Online", email: "donaldducky_da@hotmail.com" },
  { name: "Hassakol (Buzz) Panaspraipong Online", email: "hpanaspraipong@gmail.com" },
  { name: "Photcharaphong (Aong) Rodmanee", phoneNumber: "66909017181", email: "aongynessuer@gmail.com" },
  { name: "Usanee (Aey) Tortermpun Online", email: "usaneetor.mu@gmail.com" },
  { name: "Tulya (Kristie) Online", email: "chuchart2488@gmail.com" },
  { name: "Sanpat (Copter) Chanthanuraks Online", email: "copter12349@gmail.com" },
  { name: "Kijpat (Dome) Thavorn Online", email: "kijpat.bgt@gmail.com" },
  { name: "Kavin (Kavin) Diwan Singh Online", email: "diwansinghkavin@gmail.com" },
  { name: "Raksilp (Euro) Chotemongkolkul Online", email: "raksilpzas@gmail.com" },
  { name: "Thossaporn (Sun) Thatsananutariyakul Online", email: "thossaporn.sun@gmail.com" },
  { name: "Nithit (Nithit) Singhsachthep Online", email: "pemarinzig@gmail.com" },
  { name: "Calvin (Calvin) Lim Wen Quan Online", email: "calvp10@gmail.com" },
  { name: "Menika (Menika) Ratnakovit Online", email: "menika43@gmail.com" },
  { name: "Nonthawat (Rew) Lertprasitchok Online", email: "nonthawat.lert@gmail.com" },
  { name: "Karuetat (Brook) Panaspraipong Online", email: "karuetat.learning@gmail.com" },
  { name: "Rachata (Mek) Sakpuaram Online", email: "meak44051@gmail.com" },
  { name: "Dolruethai (Glai) Rodma Online", email: "glaiialgdolruethai@gmail.com" },
  { name: "Warit (Shop) Trikasemsak Online", email: "shopwarit5577@gmail.com" },
  { name: "Supatin (Sand) Mankongvanichkul Online", email: "supatinmank@gmail.com" },
  { name: "Mandy (Mandy) Boontanrart Online", email: "boontanrart2@gmail.com" },
  { name: "Phurit (Mookie) Bovornchutichai Online", email: "mookie.apimook@gmail.com" },
  { name: "Sorawit (Bank) Eaknipitsari Online", email: "sorawit_789@hotmail.com" },
  { name: "Chinnakrit (Celeste) Channiti Online", email: "cchanniti@gmail.com" },
  { name: "Nacha (Poi) Srinakarin", phoneNumber: "66952072521", email: "nacha.srin@gmail.com" },
  { name: "Vasinee (Prae) Chuenglertsiri", phoneNumber: "66992175189", email: "vaschueng@gmail.com" },
  { name: "Chanamon (Pearcha) Rattanapittayaporn", phoneNumber: "66872823004" },
  { name: "Karuetat (Brook) Panaspraipong", phoneNumber: "66990988008", email: "karuetat.pan@gmail.com" },
  { name: "Kijpat (Dome) Thavorn", phoneNumber: "66982529445", email: "kjdome09@gmail.com" },
  { name: "Sorawit (Bank) Eaknipitsari", phoneNumber: "66818748483", email: "e.sorawit@gmail.com" },
  { name: "Tuss (JJ) Arphaadul", phoneNumber: "66896091155", email: "tuss44@gmail.com" },
];

function clean(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isOnlineContactName(name: string): boolean {
  return /\bOnline\s*$/i.test(name.trim());
}

function baseContactName(name: string): string {
  return name.replace(/\s+Online\s*$/i, "").trim();
}

function extractNickname(name: string): string | null {
  return baseContactName(name).match(/\(([^)]+)\)/)?.[1]?.trim() ?? null;
}

export function canonicalKeyFromContactName(
  name: string,
  aliases: Map<string, string> = DEFAULT_CONTACT_ALIASES,
): string {
  const nickname = extractNickname(name);
  const rawKey = nickname ?? baseContactName(name);
  return aliases.get(rawKey.toLowerCase()) ?? rawKey;
}

export function buildDefaultTutorContacts(
  rawContacts: RawTutorContact[] = RAW_TUTOR_CONTACTS,
  aliases: Map<string, string> = DEFAULT_CONTACT_ALIASES,
): DefaultTutorContact[] {
  const byKey = new Map<string, DefaultTutorContact>();

  for (const contact of rawContacts) {
    const canonicalKey = canonicalKeyFromContactName(contact.name, aliases);
    const existing = byKey.get(canonicalKey) ?? {
      canonicalKey,
      displayName: baseContactName(contact.name),
      onsiteEmail: null,
      onlineEmail: null,
      onsitePhone: null,
      onlinePhone: null,
      sourceNames: [],
    };

    if (!existing.sourceNames.includes(contact.name)) {
      existing.sourceNames.push(contact.name);
    }

    const email = clean(contact.email);
    const phone = clean(contact.phoneNumber);
    if (isOnlineContactName(contact.name)) {
      existing.onlineEmail ??= email;
      existing.onlinePhone ??= phone;
    } else {
      existing.displayName = baseContactName(contact.name);
      existing.onsiteEmail ??= email;
      existing.onsitePhone ??= phone;
    }

    byKey.set(canonicalKey, existing);
  }

  return [...byKey.values()].sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
}
