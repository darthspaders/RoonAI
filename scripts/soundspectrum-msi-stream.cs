using System;
using System.IO;
using System.Runtime.InteropServices;

// Read-only access to embedded cabinets. This never executes MSI installation.
public static class SoundSpectrumMsiStream
{
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] static extern uint MsiOpenDatabaseW(string path, IntPtr persist, out uint handle);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] static extern uint MsiDatabaseOpenViewW(uint database, string query, out uint view);
    [DllImport("msi.dll")] static extern uint MsiViewExecute(uint view, uint record);
    [DllImport("msi.dll")] static extern uint MsiViewFetch(uint view, out uint record);
    [DllImport("msi.dll")] static extern uint MsiRecordReadStream(uint record, uint field, byte[] buffer, ref uint size);
    [DllImport("msi.dll")] static extern uint MsiCloseHandle(uint handle);

    static void Check(uint status)
    {
        if (status != 0) throw new IOException("Read-only MSI access failed (" + status + ").");
    }

    public static void Extract(string package, string cabinetName, string output)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(cabinetName, @"^cab[0-9]+\.cab$")) throw new ArgumentException("Unexpected cabinet name.");
        uint database = 0, view = 0, record = 0;
        try
        {
            Check(MsiOpenDatabaseW(package, IntPtr.Zero, out database));
            Check(MsiDatabaseOpenViewW(database, "SELECT `Data` FROM `_Streams` WHERE `Name` = '" + cabinetName + "'", out view));
            Check(MsiViewExecute(view, 0));
            Check(MsiViewFetch(view, out record));
            byte[] buffer = new byte[65536];
            using (FileStream stream = File.Create(output))
            {
                while (true)
                {
                    uint count = (uint)buffer.Length;
                    Check(MsiRecordReadStream(record, 1, buffer, ref count));
                    if (count == 0) break;
                    stream.Write(buffer, 0, (int)count);
                }
            }
        }
        finally
        {
            if (record != 0) MsiCloseHandle(record);
            if (view != 0) MsiCloseHandle(view);
            if (database != 0) MsiCloseHandle(database);
        }
    }
}
