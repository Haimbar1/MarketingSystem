// A flexible ad's placement customisation (Ads Manager's "customise media / text per placement"):
// `asset_feed_spec.asset_customization_rules` point at assets by their label (`adlabels` on an image /
// video / text). When a copy changes the texts or media, a rule may point at a label no asset carries
// any more, and Meta refuses the whole creative ("Target rule label must refer to asset label",
// #100/2446173 - Haim's first real build, 2026-11-20). Texts keep their labels where they can
// (applyTexts); here every rule label that no asset has is dropped, a rule left with none is dropped,
// and with no rules left the placement optimisation goes too.
const LISTS: Record<string, string> = {
  image_label: 'images', video_label: 'videos', body_label: 'bodies', title_label: 'titles',
  description_label: 'descriptions', link_url_label: 'link_urls', carousel_label: 'carousels',
};

export function fixAssetRules(afs: any): any {
  if (!afs || !Array.isArray(afs.asset_customization_rules)) return afs;
  const has = (list: string, label: any) => (Array.isArray(afs[list]) ? afs[list] : []).some((a: any) =>
    (a?.adlabels || []).some((l: any) => (label?.name && l?.name === label.name) || (label?.id && l?.id && String(l.id) === String(label.id))));
  const rules: any[] = [];
  for (const rule of afs.asset_customization_rules) {
    const r = { ...rule };
    let labels = 0;
    for (const key of Object.keys(r)) {
      if (!key.endsWith('_label')) continue;
      const list = LISTS[key];
      if (list && has(list, r[key])) labels++;
      else delete r[key];
    }
    if (labels) rules.push(r);
  }
  if (rules.length) afs.asset_customization_rules = rules;
  else {
    delete afs.asset_customization_rules;
    if (afs.optimization_type === 'PLACEMENT') delete afs.optimization_type;
  }
  return afs;
}

// Meta retired "standard enhancements" (`degrees_of_freedom_spec.creative_features_spec.standard_enhancements`):
// a creative copied from an older ad that still has it is refused — "Creative should not include standard
// enhancements … Please choose to set individual features instead" (#100/3858504, Haim's fourth try,
// 2026-11-20). The copy keeps every individual feature the ad had and drops only that one; with nothing
// left, the whole spec goes (Meta's defaults).
export function cleanDof(dof: any): any {
  if (!dof || typeof dof !== 'object') return undefined;
  const out = JSON.parse(JSON.stringify(dof));
  const cfs = out.creative_features_spec;
  if (cfs && typeof cfs === 'object') {
    delete cfs.standard_enhancements;
    if (!Object.keys(cfs).length) delete out.creative_features_spec;
  }
  return Object.keys(out).length ? out : undefined;
}
