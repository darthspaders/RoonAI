"""Verify native ELF LOAD alignment for Android devices using 16 KiB pages."""
import pathlib
import struct
import zipfile
apk = pathlib.Path(__file__).resolve().parent.parent / "app/build/outputs/apk/debug/app-debug.apk"
with zipfile.ZipFile(apk) as archive:
    native = [n for n in archive.namelist() if n.endswith(".so")]
    assert native
    for name in native:
        data = archive.read(name)
        assert data[:5] == b"\x7fELF\x02", name
        offset = struct.unpack_from("<Q", data, 32)[0]
        size, count = struct.unpack_from("<HH", data, 54)
        aligns = [struct.unpack_from("<Q", data, offset + i * size + 48)[0] for i in range(count) if struct.unpack_from("<I", data, offset + i * size)[0] == 1]
        assert aligns and min(aligns) >= 16384, (name, aligns)
        print(name, "LOAD alignment:", min(aligns))
    assert "assets/model/am/final.mdl" in archive.namelist()
print("Native alignment and bundled offline model verified.")
