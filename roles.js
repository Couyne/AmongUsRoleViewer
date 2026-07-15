// Among Us - вывод ролей игроков (external, frida, без il2cpp-bridge)
// Резолвит классы/поля через экспорты GameAssembly.dll в рантайме.

const MODULE = "GameAssembly.dll";

const ROLE_NAMES = {
    0: "Crewmate", 1: "Impostor", 2: "Scientist", 3: "Engineer",
    4: "GuardianAngel", 5: "Shapeshifter", 6: "CrewmateGhost",
    7: "ImpostorGhost", 8: "Noisemaker", 9: "Phantom",
    10: "Tracker", 12: "Detective", 18: "Viper",
};

function fn(name, ret, args) {
    const p = Module.getExportByName(MODULE, name);
    return new NativeFunction(p, ret, args);
}

// --- il2cpp API ---
const il2cpp = {
    domain_get:            fn("il2cpp_domain_get", "pointer", []),
    thread_attach:         fn("il2cpp_thread_attach", "pointer", ["pointer"]),
    domain_get_assemblies: fn("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]),
    assembly_get_image:    fn("il2cpp_assembly_get_image", "pointer", ["pointer"]),
    image_get_name:        fn("il2cpp_image_get_name", "pointer", ["pointer"]),
    class_from_name:       fn("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]),
    class_get_field:       fn("il2cpp_class_get_field_from_name", "pointer", ["pointer", "pointer"]),
    field_get_offset:      fn("il2cpp_field_get_offset", "uint32", ["pointer"]),
    field_static_get:      fn("il2cpp_field_static_get_value", "void", ["pointer", "pointer"]),
};

function cstr(s) { return Memory.allocUtf8String(s); }

// найти image "Assembly-CSharp"
function findImage(name) {
    const domain = il2cpp.domain_get();
    il2cpp.thread_attach(domain);
    const sizePtr = Memory.alloc(Process.pointerSize);
    const arr = il2cpp.domain_get_assemblies(domain, sizePtr);
    const count = sizePtr.readUInt();
    for (let i = 0; i < count; i++) {
        const asm = arr.add(i * Process.pointerSize).readPointer();
        const img = il2cpp.assembly_get_image(asm);
        const imgName = il2cpp.image_get_name(img).readUtf8String();
        if (imgName === name || imgName === name + ".dll") return img;
    }
    throw new Error("image not found: " + name);
}

function getClass(img, ns, name) {
    const c = il2cpp.class_from_name(img, cstr(ns), cstr(name));
    if (c.isNull()) throw new Error("class not found: " + name);
    return c;
}

function fieldOffset(klass, field) {
    const f = il2cpp.class_get_field(klass, cstr(field));
    if (f.isNull()) throw new Error("field not found: " + field);
    return il2cpp.field_get_offset(f);
}

// читаем C# string (System.String)
function readCSharpString(ptr) {
    if (ptr.isNull()) return "<null>";
    const len = ptr.add(is64 ? 0x10 : 0x8).readS32();
    const chars = ptr.add(is64 ? 0x14 : 0xC);
    return chars.readUtf16String(len);
}

const is64 = Process.pointerSize === 8;

function main() {
    const img = findImage("Assembly-CSharp");

    const cGameData = getClass(img, "", "GameData");
    const cNetInfo  = getClass(img, "", "NetworkedPlayerInfo");
    const cOutfit   = getClass(img, "", "NetworkedPlayerInfo/PlayerOutfit");

    // static GameData.Instance
    const fInstance = il2cpp.class_get_field(cGameData, cstr("Instance"));
    const instBuf = Memory.alloc(Process.pointerSize);
    il2cpp.field_static_get(fInstance, instBuf);
    const gameData = instBuf.readPointer();
    if (gameData.isNull()) { console.log("[!] Нет активной игры (GameData.Instance == null). Зайди в лобби/матч."); return; }

    const offAllPlayers = fieldOffset(cGameData, "AllPlayers");
    const offRoleType   = fieldOffset(cNetInfo, "RoleType");
    const offPlayerId   = fieldOffset(cNetInfo, "PlayerId");
    const offOutfits    = fieldOffset(cNetInfo, "Outfits");
    const offIsDead     = fieldOffset(cNetInfo, "IsDead");

    // List<NetworkedPlayerInfo> AllPlayers
    const list = gameData.add(offAllPlayers).readPointer();
    if (list.isNull()) { console.log("[!] AllPlayers пуст"); return; }

    const cList = getClass(img, "System.Collections.Generic", "List`1");
    const offItems = fieldOffset(cList, "_items");
    const offSize  = fieldOffset(cList, "_size");

    const items = list.add(offItems).readPointer(); // Il2CppArray
    const size  = list.add(offSize).readS32();
    const arrDataOff = is64 ? 0x20 : 0x10; // начало данных Il2CppArray

    console.log("\n===== РОЛИ ИГРОКОВ =====");
    for (let i = 0; i < size; i++) {
        const pd = items.add(arrDataOff + i * Process.pointerSize).readPointer();
        if (pd.isNull()) continue;

        const playerId = pd.add(offPlayerId).readU8();
        const roleType = pd.add(offRoleType).readU16();
        const isDead   = pd.add(offIsDead).readU8() !== 0;

        // имя: Outfits[Default].PlayerName. Проще дернуть get_PlayerName, но обойдёмся без метода:
        // берём первый Outfit из словаря. Надёжнее — вызвать метод, ниже fallback по dict.
        let name = readPlayerName(pd, offOutfits, cOutfit);

        const roleName = ROLE_NAMES[roleType] !== undefined ? ROLE_NAMES[roleType] : ("Unknown(" + roleType + ")");
        console.log(`  #${playerId}  ${name}${isDead ? " (мёртв)" : ""}  ->  ${roleName}`);
    }
    console.log("========================\n");
}

// вытащить имя из Dictionary<PlayerOutfitType, PlayerOutfit> Outfits
function readPlayerName(pd, offOutfits, cOutfit) {
    try {
        const dict = pd.add(offOutfits).readPointer();
        if (dict.isNull()) return "<no outfit>";
        // Dictionary: entries[] @ поле "entries", count @ "count". Берём первый валидный entry.value.PlayerName
        const img = findImageCached();
        const cDict = getClass(img, "System.Collections.Generic", "Dictionary`2");
        const offEntries = fieldOffset(cDict, "entries");
        const offCount   = fieldOffset(cDict, "count");
        const entries = dict.add(offEntries).readPointer();
        const count = dict.add(offCount).readS32();
        if (entries.isNull()) return "<no entries>";

        const offName = fieldOffset(cOutfit, "PlayerName");
        // Entry<TKey,TValue>: struct {hashCode:int, next:int, key:TKey, value:TValue}
        // value (PlayerOutfit ref) лежит в конце. Размер entry вычислим грубо: пройдёмся и найдём непустое имя.
        const arrDataOff = is64 ? 0x20 : 0x10;
        // Определим stride entry: (key=enum int + value=ptr + hashCode+next). Обычно на 32-бит = 0x10.
        const stride = is64 ? 0x18 : 0x10;
        for (let e = 0; e < count; e++) {
            const entryBase = entries.add(arrDataOff + e * stride);
            // value = PlayerOutfit* — последний ptr в entry
            const outfit = entryBase.add(stride - Process.pointerSize).readPointer();
            if (outfit.isNull()) continue;
            const namePtr = outfit.add(offName).readPointer();
            const s = readCSharpString(namePtr);
            if (s && s !== "<null>" && s.length > 0) return s;
        }
        return "<no name>";
    } catch (err) {
        return "<err:" + err.message + ">";
    }
}

let _imgCache = null;
function findImageCached() {
    if (!_imgCache) _imgCache = findImage("Assembly-CSharp");
    return _imgCache;
}

try {
    main();
} catch (e) {
    console.log("[ОШИБКА] " + e.message + "\n" + e.stack);
}
