// Among Us - вывод ролей игроков (external, frida, без il2cpp-bridge)
// Резолвит классы/поля через экспорты GameAssembly.dll в рантайме.

const MODULE = "GameAssembly.dll";

const ROLE_NAMES = {
    0: "Crewmate", 1: "Impostor", 2: "Scientist", 3: "Engineer",
    4: "GuardianAngel", 5: "Shapeshifter", 6: "CrewmateGhost",
    7: "ImpostorGhost", 8: "Noisemaker", 9: "Phantom",
    10: "Tracker", 12: "Detective", 18: "Viper",
};

// FIX: старый API Module.getExportByName убрали в новых версиях Frida (16.x).
// Теперь нужно сначала получить модуль через Process.getModuleByName().
function fn(name, ret, args) {
    const p = Process.getModuleByName(MODULE).getExportByName(name);
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
    // FIX2: класс инстанцированного дженерика (List<T> с реальными оффсетами)
    // можно взять только у живого объекта — у определения List`1 оффсеты = 0.
    object_get_class:      fn("il2cpp_object_get_class", "pointer", ["pointer"]),
    class_get_method:      fn("il2cpp_class_get_method_from_name", "pointer", ["pointer", "pointer", "int"]),
    runtime_invoke:        fn("il2cpp_runtime_invoke", "pointer", ["pointer", "pointer", "pointer", "pointer"]),
};

function cstr(s) { return Memory.allocUtf8String(s); }

// найти image по имени сборки (например "Assembly-CSharp" или "mscorlib")
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

// Пробует несколько вариантов имени поля (разные версии mscorlib/.NET
// называют внутренние поля Dictionary/List по-разному: "entries" vs "_entries").
function fieldOffsetAny(klass, names) {
    for (const n of names) {
        const f = il2cpp.class_get_field(klass, cstr(n));
        if (!f.isNull()) {
            const off = il2cpp.field_get_offset(f);
            if (off !== 0) return off; // FIX2: у generic-ОПРЕДЕЛЕНИЯ оффсеты нулевые — пропускаем
        }
    }
    throw new Error("none of fields found (or zero offsets): " + names.join(", "));
}

// FIX2: оффсет поля у класса САМОГО объекта. Для дженериков (List<T>, Dictionary<K,V>)
// это единственный надёжный способ: il2cpp_object_get_class возвращает
// инстанцированный класс с настоящими оффсетами, а не generic-определение.
function fieldOffsetOf(obj, names) {
    return fieldOffsetAny(il2cpp.object_get_class(obj), Array.isArray(names) ? names : [names]);
}

// FIX2: вызов инстанс-метода без аргументов через il2cpp_runtime_invoke
function invoke0(klass, methodName, obj) {
    const m = il2cpp.class_get_method(klass, cstr(methodName), 0);
    if (m.isNull()) throw new Error("method not found: " + methodName);
    const exc = Memory.alloc(Process.pointerSize);
    exc.writePointer(NULL);
    const ret = il2cpp.runtime_invoke(m, obj, NULL, exc);
    if (!exc.readPointer().isNull()) throw new Error("exception in " + methodName);
    return ret;
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

    // FIX2: оффсеты _items/_size берём у класса ЖИВОГО объекта списка.
    // У generic-определения List`1 (даже из mscorlib) il2cpp отдаёт нулевые
    // оффсеты — именно поэтому раньше size читался мусором.
    const offItems = fieldOffsetOf(list, ["_items", "items"]);
    const offSize  = fieldOffsetOf(list, ["_size", "size"]);

    const items = list.add(offItems).readPointer(); // Il2CppArray
    const size  = list.add(offSize).readS32();
    const arrDataOff = is64 ? 0x20 : 0x10; // начало данных Il2CppArray

    // Защита от мусорного значения size (если офсеты по какой-то причине не сошлись,
    // не пытаемся читать миллионы элементов и не крашимся сразу).
    if (size < 0 || size > 64) {
        console.log(`[!] Подозрительный размер списка AllPlayers: ${size}. Возможно, офсеты не совпадают с этой версией игры.`);
        console.log(`    list=${list} items=${items} offItems=${offItems} offSize=${offSize}`);
        return;
    }

    console.log("\n===== РОЛИ ИГРОКОВ =====");
    for (let i = 0; i < size; i++) {
        try {
            const pd = items.add(arrDataOff + i * Process.pointerSize).readPointer();
            if (pd.isNull()) continue;

            const playerId = pd.add(offPlayerId).readU8();
            const roleType = pd.add(offRoleType).readU16();
            const isDead   = pd.add(offIsDead).readU8() !== 0;

            // Sanity-check: валидный playerId в Among Us — 0..14 (максимум игроков).
            // Если больше — значит указатель pd битый (неверные офсеты/структура),
            // и дальше в память лезть не стоит, чтобы не поймать access violation.
            if (playerId > 20) {
                console.log(`  [пропущен] i=${i} pd=${pd} даёт мусор (playerId=${playerId}, roleType=${roleType}) — офсеты не сошлись`);
                continue;
            }

            // FIX2: имя берём вызовом настоящего геттера get_PlayerName() —
            // надёжнее, чем ручной разбор Dictionary с угаданным stride.
            let name;
            try {
                const s = invoke0(cNetInfo, "get_PlayerName", pd);
                name = readCSharpString(s);
                if (!name || name === "<null>") name = readPlayerName(pd, offOutfits, cOutfit); // fallback
            } catch (err) {
                name = readPlayerName(pd, offOutfits, cOutfit); // fallback на разбор словаря
            }

            const roleName = ROLE_NAMES[roleType] !== undefined ? ROLE_NAMES[roleType] : ("Unknown(" + roleType + ")");
            console.log(`  #${playerId}  ${name}${isDead ? " (мёртв)" : ""}  ->  ${roleName}`);
        } catch (err) {
            console.log(`  [ошибка на игроке i=${i}]: ${err.message}`);
        }
    }
    console.log("========================\n");
}

// вытащить имя из Dictionary<PlayerOutfitType, PlayerOutfit> Outfits
function readPlayerName(pd, offOutfits, cOutfit) {
    try {
        const dict = pd.add(offOutfits).readPointer();
        if (dict.isNull()) return "<no outfit>";
        // FIX2: оффсеты берём у класса живого объекта словаря (см. комментарий у списка)
        const offEntries = fieldOffsetOf(dict, ["_entries", "entries"]);
        const offCount   = fieldOffsetOf(dict, ["_count", "count"]);
        const entries = dict.add(offEntries).readPointer();
        const count = dict.add(offCount).readS32();
        if (entries.isNull()) return "<no entries>";
        if (count < 0 || count > 32) return `<bad count:${count}>`;

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

try {
    main();
} catch (e) {
    console.log("[ОШИБКА] " + e.message + "\n" + e.stack);
}
