#include <d3d11.h>
#include <cstdio>
#pragma comment(lib,"d3d11.lib")
int main(){
    ID3D11Device* dev=nullptr; ID3D11DeviceContext* ctx=nullptr;
    D3D_FEATURE_LEVEL fl=D3D_FEATURE_LEVEL_11_1;
    D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,
        D3D11_CREATE_DEVICE_VIDEO_SUPPORT,&fl,1,D3D11_SDK_VERSION,&dev,nullptr,&ctx);
    UINT s=0; dev->CheckFormatSupport(DXGI_FORMAT_NV12,&s);
    printf("NV12 support flags=0x%X\n", s);
    printf("  TEXTURE2D      : %d\n", !!(s & D3D11_FORMAT_SUPPORT_TEXTURE2D));
    printf("  SHADER_SAMPLE  : %d\n", !!(s & D3D11_FORMAT_SUPPORT_SHADER_SAMPLE));
    printf("  RENDER_TARGET  : %d\n", !!(s & D3D11_FORMAT_SUPPORT_RENDER_TARGET));
    printf("  DECODER_OUTPUT : %d\n", !!(s & D3D11_FORMAT_SUPPORT_DECODER_OUTPUT));
    // try actually creating an NV12 texture ARRAY with RENDER_TARGET|SHADER_RESOURCE
    D3D11_TEXTURE2D_DESC td{}; td.Width=1920;td.Height=1080;td.MipLevels=1;td.ArraySize=8;
    td.Format=DXGI_FORMAT_NV12;td.SampleDesc.Count=1;td.Usage=D3D11_USAGE_DEFAULT;
    td.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE;
    ID3D11Texture2D* t=nullptr;
    HRESULT h=dev->CreateTexture2D(&td,nullptr,&t);
    printf("create NV12 array[8] RT|SR : hr=0x%08lX %s\n",(unsigned long)h, SUCCEEDED(h)?"OK":"FAIL");
    if(t){t->Release();t=nullptr;}
    td.BindFlags=D3D11_BIND_RENDER_TARGET;
    h=dev->CreateTexture2D(&td,nullptr,&t);
    printf("create NV12 array[8] RT only: hr=0x%08lX %s\n",(unsigned long)h, SUCCEEDED(h)?"OK":"FAIL");
    if(t){t->Release();t=nullptr;}
    // single (non-array) NV12 RT
    td.ArraySize=1; td.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE;
    h=dev->CreateTexture2D(&td,nullptr,&t);
    printf("create NV12 single  RT|SR : hr=0x%08lX %s\n",(unsigned long)h, SUCCEEDED(h)?"OK":"FAIL");
    return 0;
}
