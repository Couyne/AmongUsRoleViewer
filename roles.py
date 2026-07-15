#!/usr/bin/env python3
# Windows: python roles.py            (attach к запущенной игре)
import sys, frida, os

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roles.js")

def on_message(msg, data):
    if msg["type"] == "send":
        print(msg["payload"])
    elif msg["type"] == "log":
        print(msg["payload"])
    elif msg["type"] == "error":
        print("[JS ERROR]", msg.get("description"), msg.get("stack", ""))

def on_log(level, text):
    print(text)

def main():
    with open(SCRIPT, "r", encoding="utf-8") as f:
        code = f.read()

    pid = None
    if len(sys.argv) >= 3 and sys.argv[1] == "--spawn":
        pid = frida.spawn(sys.argv[2])
        session = frida.attach(pid)
    else:
        # ищем процесс по подстроке "among us"
        device = frida.get_local_device()
        target = None
        for p in device.enumerate_processes():
            n = p.name.lower()
            if "among us" in n and "crashhandler" not in n:
                target = p
                break
        if target is None:
            print("[!] Процесс Among Us не найден. Запусти игру или используй --spawn.")
            return
        print(f"[+] Найден: {target.name} (pid {target.pid})")
        session = frida.attach(target.pid)

    script = session.create_script(code)
    script.on("message", on_message)
    script.set_log_handler(on_log)
    script.load()
    if pid is not None:
        frida.resume(pid)

    # держим сессию, чтобы console.log дошёл
    try:
        sys.stdin.read()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
