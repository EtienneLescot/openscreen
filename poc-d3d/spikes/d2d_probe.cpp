// S0 spike — Direct2D as a "remove work" candidate (§3).
// Questions tranchées :
//   K2  : un ID2D1Device se crée-t-il sur le MÊME ID3D11Device (interop sans copie) ?
//   E3  : l'effet natif Gaussian Blur floute-t-il réellement une texture D3D11 ?
//   E4  : l'effet natif Shadow produit-il une ombre portée ?
// Sortie : lignes RESULT: k=v, lisibles par le runner.
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d2d1_1.h>
#include <d2d1effects.h>
#include <d2d1effects_2.h>   // CLSID_D2D1YCbCr (NV12 -> RGB)
#include <cstdio>
#include <cmath>
#include <vector>
#pragma comment(lib,"d3d11.lib")
#pragma comment(lib,"d2d1.lib")
#pragma comment(lib,"dxgi.lib")
#pragma comment(lib,"dxguid.lib")  // CLSID_D2D1GaussianBlur / CLSID_D2D1Shadow

#define CK(hr,msg) do{ HRESULT _h=(hr); if(FAILED(_h)){ printf("RESULT: fail=%s hr=0x%08lX\n",msg,(unsigned long)_h); return 1913; } }while(0)

static const UINT W=512,H=512;

// netteté = gradient horizontal moyen du canal vert (BGRA)
static double sharpness(const std::vector<unsigned char>& px, UINT pitch){
    double acc=0; UINT n=0;
    for(UINT y=0;y<H;++y){
        const unsigned char* row=px.data()+y*pitch;
        for(UINT x=1;x<W;++x){ acc+=std::abs((int)row[x*4+1]-(int)row[(x-1)*4+1]); ++n; }
    }
    return n?acc/n:0;
}

int main(){
    // --- D3D11 device (BGRA requis par D2D), feature level 11_1 comme le §2 ---
    D3D_FEATURE_LEVEL want[]={D3D_FEATURE_LEVEL_11_1};
    ID3D11Device* dev=nullptr; ID3D11DeviceContext* ctx3d=nullptr; D3D_FEATURE_LEVEL got{};
    CK(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,want,1,D3D11_SDK_VERSION,&dev,&got,&ctx3d),"d3d11_create");
    printf("RESULT: d3d11_device=ok feature_level=0x%X\n",(unsigned)got);

    // --- K2 : D2D device sur le MÊME device via son IDXGIDevice ---
    IDXGIDevice* dxgi=nullptr; CK(dev->QueryInterface(__uuidof(IDXGIDevice),(void**)&dxgi),"qi_dxgi");
    ID2D1Device* d2dDev=nullptr;
    CK(D2D1CreateDevice(dxgi,nullptr,&d2dDev),"d2d_create_device");
    ID2D1DeviceContext* dc=nullptr;
    CK(d2dDev->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE,&dc),"d2d_ctx");
    printf("RESULT: k2_d2d_shares_d3d11_device=ok\n");

    // --- texture source : rayures verticales 2px (gradient max) ---
    std::vector<unsigned char> src(W*H*4);
    for(UINT y=0;y<H;++y)for(UINT x=0;x<W;++x){
        unsigned char v=((x/2)&1)?255:0; size_t o=(y*W+x)*4;
        src[o]=v;src[o+1]=v;src[o+2]=v;src[o+3]=255;
    }
    D3D11_TEXTURE2D_DESC td{}; td.Width=W;td.Height=H;td.MipLevels=1;td.ArraySize=1;
    td.Format=DXGI_FORMAT_B8G8R8A8_UNORM;td.SampleDesc.Count=1;td.Usage=D3D11_USAGE_DEFAULT;
    td.BindFlags=D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA sd{}; sd.pSysMem=src.data(); sd.SysMemPitch=W*4;
    ID3D11Texture2D* srcTex=nullptr; CK(dev->CreateTexture2D(&td,&sd,&srcTex),"src_tex");

    // wrap D3D11 -> D2D bitmap (zéro copie : même surface DXGI)
    IDXGISurface* srcSurf=nullptr; CK(srcTex->QueryInterface(__uuidof(IDXGISurface),(void**)&srcSurf),"src_surf");
    D2D1_BITMAP_PROPERTIES1 bp=D2D1::BitmapProperties1(
        D2D1_BITMAP_OPTIONS_NONE,
        D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM,D2D1_ALPHA_MODE_PREMULTIPLIED));
    ID2D1Bitmap1* srcBmp=nullptr; CK(dc->CreateBitmapFromDxgiSurface(srcSurf,&bp,&srcBmp),"src_bmp");

    // --- cible : texture render-target, wrap en bitmap TARGET ---
    D3D11_TEXTURE2D_DESC tt=td; tt.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE;
    ID3D11Texture2D* dstTex=nullptr; CK(dev->CreateTexture2D(&tt,nullptr,&dstTex),"dst_tex");
    IDXGISurface* dstSurf=nullptr; CK(dstTex->QueryInterface(__uuidof(IDXGISurface),(void**)&dstSurf),"dst_surf");
    D2D1_BITMAP_PROPERTIES1 tp=D2D1::BitmapProperties1(
        D2D1_BITMAP_OPTIONS_TARGET,
        D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM,D2D1_ALPHA_MODE_PREMULTIPLIED));
    ID2D1Bitmap1* dstBmp=nullptr; CK(dc->CreateBitmapFromDxgiSurface(dstSurf,&tp,&dstBmp),"dst_bmp");

    // staging pour relire
    D3D11_TEXTURE2D_DESC stg=td; stg.Usage=D3D11_USAGE_STAGING; stg.BindFlags=0;
    stg.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
    ID3D11Texture2D* stgTex=nullptr; CK(dev->CreateTexture2D(&stg,nullptr,&stgTex),"stg_tex");

    auto readback=[&](const char* tag)->double{
        ctx3d->CopyResource(stgTex,dstTex); ctx3d->Flush();
        D3D11_MAPPED_SUBRESOURCE m{}; CK(ctx3d->Map(stgTex,0,D3D11_MAP_READ,0,&m),"map");
        std::vector<unsigned char> out(m.RowPitch*H);
        memcpy(out.data(),m.pData,out.size());
        ctx3d->Unmap(stgTex,0);
        return sharpness(out,m.RowPitch);
    };

    double sharp_src=sharpness(src,W*4);
    printf("RESULT: sharp_source=%.2f\n",sharp_src);

    // --- E3 : Gaussian Blur natif ---
    {
        ID2D1Effect* blur=nullptr; CK(dc->CreateEffect(CLSID_D2D1GaussianBlur,&blur),"blur_effect");
        blur->SetInput(0,srcBmp);
        CK(blur->SetValue(D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION,12.0f),"blur_sigma");
        dc->SetTarget(dstBmp); dc->BeginDraw();
        dc->Clear(D2D1::ColorF(0,0,0,1));
        dc->DrawImage(blur);
        CK(dc->EndDraw(),"blur_enddraw");
        double s=readback("blur");
        printf("RESULT: e3_gaussian_blur=ok sharp_after=%.2f ratio=%.3f\n",s,s/sharp_src);
        blur->Release();
    }
    // --- E4 : Shadow natif (source opaque -> ombre décalée sur fond) ---
    {
        ID2D1Effect* shadow=nullptr;
        HRESULT hs=dc->CreateEffect(CLSID_D2D1Shadow,&shadow);
        if(SUCCEEDED(hs)){
            shadow->SetInput(0,srcBmp);
            shadow->SetValue(D2D1_SHADOW_PROP_BLUR_STANDARD_DEVIATION,8.0f);
            dc->SetTarget(dstBmp); dc->BeginDraw();
            dc->Clear(D2D1::ColorF(1,1,1,1));
            dc->DrawImage(shadow);
            HRESULT he=dc->EndDraw();
            printf("RESULT: e4_shadow=%s\n",SUCCEEDED(he)?"ok":"draw_fail");
            shadow->Release();
        } else {
            printf("RESULT: e4_shadow=create_fail hr=0x%08lX\n",(unsigned long)hs);
        }
    }
    // --- K2 réel : le décodeur sort du NV12. D2D peut-il l'emballer directement ? ---
    {
        D3D11_TEXTURE2D_DESC nd{}; nd.Width=W; nd.Height=H; nd.MipLevels=1; nd.ArraySize=1;
        nd.Format=DXGI_FORMAT_NV12; nd.SampleDesc.Count=1; nd.Usage=D3D11_USAGE_DEFAULT;
        nd.BindFlags=D3D11_BIND_SHADER_RESOURCE;
        // NV12 : plan Y (W*H) puis plan UV entrelacé (W*H/2)
        std::vector<unsigned char> nv12(W*H + W*H/2, 128);
        for(UINT y=0;y<H;++y)for(UINT x=0;x<W;++x) nv12[y*W+x]=((x/2)&1)?235:16;
        D3D11_SUBRESOURCE_DATA nsd{}; nsd.pSysMem=nv12.data(); nsd.SysMemPitch=W;
        ID3D11Texture2D* nvTex=nullptr;
        HRESULT hn=dev->CreateTexture2D(&nd,&nsd,&nvTex);
        if(FAILED(hn)){ printf("RESULT: nv12_texture=fail hr=0x%08lX\n",(unsigned long)hn); }
        else {
            IDXGISurface* nvSurf=nullptr; nvTex->QueryInterface(__uuidof(IDXGISurface),(void**)&nvSurf);
            D2D1_BITMAP_PROPERTIES1 np=D2D1::BitmapProperties1(
                D2D1_BITMAP_OPTIONS_NONE,
                D2D1::PixelFormat(DXGI_FORMAT_NV12,D2D1_ALPHA_MODE_IGNORE));
            ID2D1Bitmap1* nvBmp=nullptr;
            HRESULT hb=dc->CreateBitmapFromDxgiSurface(nvSurf,&np,&nvBmp);
            if(FAILED(hb)){ printf("RESULT: nv12_as_d2d_bitmap=fail hr=0x%08lX\n",(unsigned long)hb); }
            else {
                // effet YCbCr natif = conversion NV12->RGB (E1) sans shader maison
                ID2D1Effect* ycbcr=nullptr;
                HRESULT hy=dc->CreateEffect(CLSID_D2D1YCbCr,&ycbcr);
                if(SUCCEEDED(hy)){
                    ycbcr->SetInput(0,nvBmp);
                    dc->SetTarget(dstBmp); dc->BeginDraw(); dc->Clear(D2D1::ColorF(0,0,0,1));
                    dc->DrawImage(ycbcr); HRESULT he=dc->EndDraw();
                    printf("RESULT: nv12_ingest=ok e1_ycbcr_effect=%s\n",SUCCEEDED(he)?"ok":"draw_fail");
                    ycbcr->Release();
                } else printf("RESULT: nv12_ingest=ok e1_ycbcr_effect=create_fail hr=0x%08lX\n",(unsigned long)hy);
                nvBmp->Release();
            }
            if(nvSurf)nvSurf->Release(); nvTex->Release();
        }
    }
    printf("RESULT: done=ok\n");
    return 0;
}
