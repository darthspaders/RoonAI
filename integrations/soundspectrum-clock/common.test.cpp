#include "common.hpp"
#include <cstdio>
int main(){
 wchar_t temp[32768];GetTempPathW(32768,temp);const auto root=std::wstring(temp)+L"RhClockTest-"+std::to_wstring(GetCurrentProcessId());
 if(!CreateDirectoryW(root.c_str(),nullptr))return 1;
 const auto spectrum=root+L"\\SoundSpectrum",productDir=spectrum+L"\\Test",file=productDir+L"\\Preferences (Standalone).txt";
 CreateDirectoryW(spectrum.c_str(),nullptr);CreateDirectoryW(productDir.c_str(),nullptr);
 const auto previous=env(L"APPDATA");SetEnvironmentVariableW(L"APPDATA",root.c_str());
 Product p{L"Test",L"none","none","none"};unsigned passed=0,failed=0;
 auto test=[&](const std::string& text,unsigned expected){std::ofstream out(file,std::ios::binary);out<<text;out.close();if(configuredFps(p)==expected)passed++;else failed++;};
 test("Graphics.TargetFrameRate = 120\r\n",120);test("Graphics.TargetFrameRate = 60\n",60);
 test("Graphics.TargetFrameRate = nan\n",0);test("Graphics.TargetFrameRate = inf\n",0);test("Graphics.TargetFrameRate = 120junk\n",0);
 test("Graphics.TargetFrameRate = 120.5\n",0);test("Graphics.TargetFrameRate = 0\n",0);test("Graphics.TargetFrameRate = 241\n",0);
 test("Graphics.TargetFrameRate = 120\nGraphics.TargetFrameRate = 60\n",0);test("Graphics.TargetFrameRateWrong = 120\n",0);
 std::wstring wide=L"Graphics.TargetFrameRate = 120\r\n";std::string bytes="\xff\xfe";for(auto c:wide){bytes+=(char)(c&255);bytes+=(char)(c>>8);}test(bytes,120);
 {std::ofstream out(file,std::ios::binary);out<<"abc";}
 if(sha256(file)=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")passed++;else failed++;
 if(recognize(file)==nullptr&&sameFile(file,file)&&!sameFile(file,root+L"\\missing"))passed++;else failed++;
 DeleteFileW(file.c_str());RemoveDirectoryW(productDir.c_str());RemoveDirectoryW(spectrum.c_str());RemoveDirectoryW(root.c_str());SetEnvironmentVariableW(L"APPDATA",previous.c_str());
 printf("%u passed; %u failed\n",passed,failed);return failed?1:0;
}
