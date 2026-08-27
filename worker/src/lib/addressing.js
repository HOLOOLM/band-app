// Adressering af Durable Objects.
//
// Et objekt placeres i det datacenter der ligger tættest på den FØRSTE
// forespørgsel — og bliver dér permanent. Oprettes et band mens nogen er i
// udlandet, ligger objektet der for altid, og alle fremtidige danske kald
// betaler det længere hop. Derfor pinnes placeringen eksplicit her, ét sted,
// i stedet for at være et biprodukt af hvem der tilfældigt kaldte først.
//
// jurisdiction('eu') er samtidig en GDPR-garanti: appen gemmer CPR-numre, og
// jurisdiktionen sikrer at objektet kun kører og lagrer data i EU.
//
// VIGTIGT: jurisdiktionen er en del af objektets identitet. Samme navn i og
// uden jurisdiktion giver TO forskellige objekter med hver sin database. Den
// skal derfor med fra første deploy og kan ikke ændres bagefter uden at alle
// bands mister deres data.

const JURISDICTION = 'eu';

/**
 * Henter et namespace med EU-jurisdiktion. Falder tilbage til det rå namespace,
 * hvis runtime ikke understøtter jurisdiktioner — det gælder visse lokale
 * miniflare-versioner, hvor vi hellere vil kunne udvikle end fejle hårdt.
 * Produktionsdeploy skal have jurisdiktionen; se selvtesten i _selftest.
 */
function ns(binding) {
  if (typeof binding.jurisdiction !== 'function') return { ns: binding, pinned: false };
  try {
    return { ns: binding.jurisdiction(JURISDICTION), pinned: true };
  } catch (e) {
    return { ns: binding, pinned: false };
  }
}

/** Stub til ét bands objekt. bandId er navnet — stabilt og menneskeligt læsbart. */
export function bandStub(env, bandId) {
  const id = String(bandId || '').trim();
  if (!id) throw new Error('bandStub kaldt uden bandId');
  const { ns: namespace } = ns(env.BAND);
  return namespace.get(namespace.idFromName(id));
}

/** Stub til master-objektet. Der er præcis ét, med et fast navn. */
export function masterStub(env) {
  const { ns: namespace } = ns(env.MASTER);
  return namespace.get(namespace.idFromName('master'));
}

/** Om jurisdiktionen faktisk blev anvendt. Bruges af selvtesten. */
export function jurisdictionActive(env) {
  return ns(env.BAND).pinned;
}

/**
 * Kryds-band-opslag. Kalder N band-objekter parallelt og fletter resultaterne.
 *
 * N er antallet af bands DET ENKELTE MEDLEM er med i (1-3 i praksis) — ikke det
 * samlede antal bands. Kald derfor ALDRIG denne funktion med en liste der kan
 * vokse til alle bands; operatørlisten bruger i stedet de spejlede statistikker
 * i masters bands-tabel.
 */
export async function fanOut(env, bandIds, fn) {
  const results = await Promise.allSettled(
    bandIds.map(id => fn(bandStub(env, id), id))
  );
  const out = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out.push({ bandId: bandIds[i], value: r.value });
    else failed.push({ bandId: bandIds[i], error: String(r.reason && r.reason.message || r.reason) });
  });
  // Et enkelt bands nedetid må ikke tage hele svaret ned — men det skal være
  // synligt for kalderen, så UI'et kan vise "kunne ikke hente band X".
  return { results: out, failed };
}
