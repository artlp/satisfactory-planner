"""Build data/recipes.json from the game's CommunityResources/Docs/en-US.json.
Usage: python tools/extract.py "<path to en-US.json>"
"""
import json, re, sys

src = sys.argv[1] if len(sys.argv) > 1 else r"D:\SteamLibrary\steamapps\common\Satisfactory\CommunityResources\Docs\en-US.json"
docs = json.load(open(src, encoding="utf-16"))
G = {}
for g in docs:
    G.setdefault(g["NativeClass"].split(".")[-1].rstrip("'"), []).extend(g["Classes"])

def cls(path):  # ".../Desc_IronIngot.Desc_IronIngot_C'" -> "Desc_IronIngot_C"
    return re.findall(r"\.(\w+)'?\"?\)?$", path.strip())[0]

def parse_amounts(s):
    return re.findall(r"\.(\w+)'\",Amount=(\d+)", s)

items = {c["ClassName"]: c for k, v in G.items() for c in v if "mForm" in c and c.get("mDisplayName")}
is_fluid = lambda i: items[i]["mForm"] in ("RF_LIQUID", "RF_GAS")
amt = lambda i, n: int(n) / 1000 if is_fluid(i) else int(n)  # fluids are stored in litres

buildings = {c["ClassName"]: c["mDisplayName"] for k in ("FGBuildableManufacturer", "FGBuildableManufacturerVariablePower") for c in G[k]}

used = set()
recipes = []
for r in G["FGRecipe"]:
    made_in = [b for b in re.findall(r"\.(Build_\w+)", r["mProducedIn"]) if b in buildings]
    if not made_in:
        continue
    ins = [[i, amt(i, n)] for i, n in parse_amounts(r["mIngredients"])]
    outs = [[i, amt(i, n)] for i, n in parse_amounts(r["mProduct"])]
    used.update(i for i, _ in ins + outs)
    recipes.append({
        "id": r["ClassName"], "name": r["mDisplayName"], "building": made_in[0],
        "time": float(r["mManufactoringDuration"]), "in": ins, "out": outs,
        "alt": r["ClassName"].startswith("Recipe_Alternate"),
    })

# Generators become one "recipe" per fuel: amounts are per minute (time=60), "power" is MW at 100%.
for k in ("FGBuildableGeneratorFuel", "FGBuildableGeneratorNuclear"):
    for g in G[k]:
        mw = float(g["mPowerProduction"])
        buildings[g["ClassName"]] = g["mDisplayName"]
        for f in g["mFuel"]:
            fuel = f["mFuelClass"]
            if fuel not in items:
                continue
            energy = float(items[fuel]["mEnergyValue"]) * (1000 if is_fluid(fuel) else 1)  # MJ per item or per m3
            per_min = mw * 60 / energy
            ins = [[fuel, round(per_min, 4)]]
            if f["mSupplementalResourceClass"]:
                ins.append([f["mSupplementalResourceClass"], round(mw * 60 * float(g["mSupplementalToPowerRatio"]) / 1000, 4)])
            outs = [[f["mByproduct"], round(per_min * int(f["mByproductAmount"]), 4)]] if f["mByproduct"] else []
            used.update(i for i, _ in ins + outs)
            recipes.append({"id": f"Power_{g['ClassName']}_{fuel}", "name": f"Power: {items[fuel]['mDisplayName']}",
                            "building": g["ClassName"], "time": 60.0, "in": ins, "out": outs, "alt": False, "power": mw})

extractors = []
for k in ("FGBuildableResourceExtractor", "FGBuildableWaterPump", "FGBuildableFrackingExtractor"):
    for c in G[k]:
        allowed = [cls(p) for p in c["mAllowedResources"].strip("()").split(",") if p] if c["mOnlyAllowCertainResources"] == "True" \
            else [i["ClassName"] for i in G["FGResourceDescriptor"] if i["mForm"] == "RF_SOLID"]
        per_cycle = int(c["mItemsPerCycle"]) / (1000 if "RF_SOLID" not in c["mAllowedResourceForms"] else 1)
        extractors.append({"id": c["ClassName"], "name": c["mDisplayName"], "allowed": allowed,
                           "rate": round(per_cycle / float(c["mExtractCycleTime"]) * 60, 3)})
        used.update(allowed)

belts = sorted({(c["mDisplayName"], float(c["mSpeed"]) / 2) for c in G["FGBuildableConveyorBelt"]}, key=lambda b: b[1])
pipes = sorted({(c["mDisplayName"].replace("Clean ", ""), float(c["mFlowLimit"]) * 60) for c in G["FGBuildablePipeline"]}, key=lambda b: b[1])

out = {
    "items": {i: {"name": items[i]["mDisplayName"], "fluid": is_fluid(i)} for i in sorted(used)},
    "buildings": buildings,
    "recipes": sorted(recipes, key=lambda r: r["name"]),
    "extractors": extractors,
    "belts": [{"name": n, "rate": r} for n, r in belts],
    "pipes": [{"name": n, "rate": r, "fluid": True} for n, r in pipes],
}
assert len(out["recipes"]) > 100 and all(r["out"] or r.get("power") for r in out["recipes"])
json.dump(out, open("data/recipes.json", "w", encoding="utf-8"), separators=(",", ":"))
print(len(out["recipes"]), "recipes,", len(out["items"]), "items,", len(extractors), "extractors")
