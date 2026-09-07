// Blokliste over kendte svage adgangskoder.
//
// HVORFOR DEN SER SÅDAN UD: klienten sender sha256(password), ikke selve
// koden — det er hele grunden til at et password aldrig når serveren i
// klartekst. Konsekvensen er at serveren IKKE kan måle længde, tegnsæt eller
// entropi. Minimumslængden i public/js/02-auth.js er derfor kosmetik: enhver
// der taler direkte med API'et kan sætte "1234".
//
// Det man KAN gøre uden at ændre protokollen, er at genkende hashen af de
// koder folk faktisk vælger. Listen fanger ikke en dårlig kode man selv finder
// på, men den fanger de værste, og den kan ikke omgås fra klienten.
//
// Ægte længdehåndhævelse kræver at adgangskoden sendes over TLS og hashes
// serverside. Det er en protokolændring, ikke en rettelse — se
// SECURITY-AUDIT-2026-09-07.md, M12.
//
// Hashene er sha256 af koden i UTF-8, hex, små bogstaver. Tilføj flere ved at
// køre:  node -e "console.log(require('crypto').createHash('sha256').update('kode').digest('hex'))"

const SVAGE = new Set([
  '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
  '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
  'ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f',
  '65e84be33532fb784c48129675f9eff3a682b27168c0ea744b2cf58ee02337c5',
  '15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225',
  '5994471abb01112afcc18159f6cc74b4f511b99806da59b3caf5a9c173cacfc5',
  '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',
  'bcb15f821479b4d5772bd0ca866c00ad5f926e3580720659cc80d39c9d09802a',
  '8bb0cf6eb9b17d0f7d22b456f121257dc1254e1f01665370476383ea776df414',
  'a9c43be948c5cabd56ef2bacffb77cdaa5eec49dd5eb0cc4129cf3eda5f0e74c',
  '96cae35ce8a9b0244178bf28e4966c2ce1b8385723a96a6b838858cdd6ca0a1e',
  '6ca13d52ca70c883e0f0bb101e425a89e8624de51db2d2392593af6a84118090',
  'e4ad93ca07acb8d908a3aa41e920ea4f4ef4f26e7f86cf8291c5db289780a5ae',
  '0b14d501a594442a01c6859541bcb3e8164d183d32937b851835442f69d5c94e',
  'c775e7b757ede630cd0aa1113bd102661ab38829ca52a6422ab782862f268646',
  '91b4d142823f7d20c5f08df69122de43f35f057a988d9619f6d3138485c9a203',
  'daaad6e5604e8e17bd9f108d91e26afe6281dac8fda0091040a7a6d7bd9b43b5',
  'c0c4a69b17a7955ac230bfc8db4a123eaa956ccf3c0022e68b8d4e2f5b699d1f',
  'a941a4c4fd0c01cddef61b8be963bf4c1e2b0811c037ce3f1835fddf6ef6c223',
  '04e77bf8f95cb3e1a36a59d1e93857c411930db646b46c218a0352e432023cf2',
  '6382deaf1f5dc6e792b76db4a4a7bf2ba468884e000b25e7928e621e27fb23cb',
  '000c285457fc971f862a79b786476c78812c8897063c6fa9c045f579a3b2d63f',
  '1c8bfe8f801d79745c4631d09fff36c82aa37fc4cce4fc946683d7b336b63032',
  '280d44ab1e9f79b5cce2dd4f58f5fe91f0fbacdac9f7447dffc318ceb79f2d02',
  '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',
  '428821350e9691491f616b754cd8315fb86d797ab35d843479e732ef90665324',
  'fc613b4dfd6736a7bd268c8a0e74ed0d1c04a959f59dd74ef2874983fd443fc9',
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  '13b1f7ec5beaefc781e43a3b344371cd49923a8a05edd71844b92f56f6a08d38',
  '85738f8f9a7f1b04b5329c590ebcb9e425925c6d0984089c43a022de4f19c281',
  '203b70b5ae883932161bbd0bded9357e763e63afce98b16230be33f0b94c2cc5',
  '481f6cc0511143ccdd7e2d1b1b94faf0a700a8b49cd13922a70b5ae28acaa8c5',
  '73cd1b16c4fb83061ad18a0b29b9643a68d4640075a466dc9e51682f84a847f5',
  '88b1cca59060320e5e5662a7da636884eb7580f4dc7e22cfb6f88b8f99045a71',
  '34550715062af006ac4fab288de67ecb44793c3a05c475227241535f6ef7a81b',
  '0bb09d80600eec3eb9d7793a6f859bedde2a2d83899b70bd78e961ed674b32f4',
  '8f0e2f76e22b43e2855189877e7dc1e1e7d98c226c95db247cd1d547928334a9',
  '19513fdc9da4fb72a4a05eb66917548d3c90ff94d5419e1f2363eea89dfee1dd',
  '008c70392e3abfbd0fa47bbc2ed96aa99bd49e159727fcba0f2e6abeb3a9d601',
  '99ca9d959b395b4cee37275607a2feaa195887d3642c808c394cf916f0e5d2c2',
  '7da48e647c7af4a2cc8330c0f4ed45d8ab79b79a4c358d6699b8686b80155bb2',
  'c71f77ad20c73ee0d12d8636368b80a72cdc8bf36b1a80a78c0cb7c6b2b8109a',
  '6e01e5534e3ddad9fbaeb0601dccc6cbe03e17219d45d9aa99f1f54391d77475',
  '8eea19ee204c0bc48ac9db0df7e593e303231945c52162ab7b2667fac750dfa8',
  '2558c21c8f24dcfbcd953237a43c71507a3d3e40f571a2ac7d966b41a74bc132',
  '804e445bb10e5ddd3e1ca92b3228b1da4b1bc1f7120671c7dae1cba2c529b7dc',
  '777b6edca9467d9b5f84a71081e1d259e6485ff805ddb5813742fc02d63de0cb',
  '848191b81ef728c48783fb06863eac12ad04222f36629989e439c832b24fe798',
  'f646555b50c5220898b9d0adcbcef79f4d438fd1a16b1134af412bd8569e74b1',
  'a5f55421e55c614e9f3575e56ea0697b4e2caad537f373aab019bff0300feac3',
  '937e8d5fbb48bd4949536cd65b8d35c426b80d2f830c5c308e2cdec422ae2244',
  '057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86',
  '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b',
  '9665f908959bebb436523e38123bb43ecc4b7dc135c8b25e1e98998c4e557d77',
  '15b85dbd9818a5de883c9aacf2439acb5340dded5993bfeb1d8cc42fb99b77c3',
  'd081f5e402980b267f1f87cb6b74fc3eb249de26e670a9db55dec67da7864de4',
  'a0d227d60ce6843352976b5e4df7a77bb410cbd5197571aae293688fa5ee5b77'
]);

/**
 * Returnerer en fejlbesked hvis hashen svarer til en kendt svag kode, ellers
 * null. Sammenligningen behøver ikke være konstant-tid: listen er offentlig
 * viden, og et svar afslører kun om brugerens EGET valg står på den.
 */
export function weakPasswordError(clientHash) {
  return SVAGE.has(String(clientHash || '').toLowerCase())
    ? 'Den adgangskode er for almindelig. Vælg en anden — gerne tre tilfældige ord.'
    : null;
}
