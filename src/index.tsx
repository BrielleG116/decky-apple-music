import {
  ButtonItem,
  definePlugin,
  PanelSection,
  PanelSectionRow,
  staticClasses,
  TextField,
  showModal,
  ModalRoot,
  Focusable,
  SidebarNavigation,
} from "@decky/ui";
import { callable, toaster } from "@decky/api";
import React, { useEffect, useState, useRef, useCallback } from "react";
const DEFAULT_STOREFRONT = "us";

const getDevTokenCall = callable<[], { token: string }>("get_dev_token");
// Fetch Apple's harvested developer token from the player (no token is shipped).
async function getDevToken(): Promise<string> {
  try { const r = await getDevTokenCall(); return (r && r.token) || ""; } catch { return ""; }
}
const getSettings  = callable<[], { developerToken: string; storefront: string; musicUserToken: string; trackToasts?: boolean; duckEnabled?: boolean; duckDepth?: number; duckRelease?: number; duckAttack?: number }>("get_settings");
const saveSettings = callable<[{ developerToken: string; storefront: string; musicUserToken: string; trackToasts?: boolean }], void>("save_settings");
const setShuffleBackend = callable<[boolean], { success: boolean }>("set_shuffle");
const setRepeatBackend = callable<[number], { success: boolean }>("set_repeat");
const setDuck = callable<[{ enabled?: boolean; depth?: number; release?: number; attack?: number }], { success: boolean; enabled?: boolean }>("set_duck");
const setAutoplay = callable<[boolean], { success: boolean; enabled?: boolean }>("set_autoplay");
const setMusicTrim = callable<[{ db: number; volume?: number }], { success: boolean; db?: number }>("set_music_trim");
const playerInstalled = callable<[], { installed: boolean; version: string; latest: string }>("player_installed");
const installPlayer = callable<[], { success: boolean; already?: boolean }>("install_player");
const installStatus = callable<[], { state: "idle" | "downloading" | "extracting" | "done" | "error"; pct: number; message: string }>("install_status");
const amApiCall = callable<[{ path: string; params?: any; options?: any }], { ok: boolean; data?: any; error?: string; status?: number }>("am_api");
const amSignOut = callable<[], { success: boolean }>("am_signout");
type LoginStep = "signedin" | "2fa" | "error";
const amLogin = callable<[{ email: string; password: string }], { step: LoginStep; error?: string; codeInputCount?: number }>("am_login");
const amSubmit2fa = callable<[{ code: string }], { step: LoginStep; error?: string }>("am_submit_2fa");

// Route MusicKit API calls through the player, which holds Apple's harvested
// developer token and rewrites the Origin so Apple accepts it. This lets the
// frontend browse without embedding a developer token of its own.
async function amApi(path: string, params?: any, options?: any): Promise<{ data: any }> {
  const res = await amApiCall({ path, params: params || {}, options: options || {} });
  if (!res || !res.ok) {
    const e: any = new Error(res?.error || "API error");
    e.status = res?.status;
    throw e;
  }
  return { data: res.data };
}
const playOnBackend = callable<{ track_id: string; type: string; url?: string; devToken?: string; musicUserToken?: string }, { success: boolean; error?: string; url?: string }>("play_on_backend");
const openInChrome = callable<string, { success: boolean; error?: string }>("open_in_chrome");

// MPRIS transport controls
const mprisPlay = callable<[], { success: boolean }>("mpris_play");
const mprisPause = callable<[], { success: boolean }>("mpris_pause");
const mprisPlayPause = callable<[], { success: boolean }>("mpris_play_pause");
const mprisNext = callable<[], { success: boolean }>("mpris_next");
const mprisPrevious = callable<[], { success: boolean }>("mpris_previous");
const mprisSeek = callable<[number], { success: boolean }>("mpris_seek");
const mprisGetStatus = callable<[], { playing: boolean; shuffle?: boolean; repeat?: number; track: { id?: string; catalogId?: string; title: string; artist: string; album: string; artworkUrl: string; duration: number; position: number } | null; position: number }>("mpris_get_status");
const mprisListPlayers = callable<[], { players: string[] }>("mpris_list_players");
const mprisSetPlayer = callable<[string], { success: boolean }>("mpris_set_player");
const getQueue = callable<[], { tracks: { id: string; title: string; artist: string; duration: number; artworkUrl: string; trackNumber: number }[]; currentIndex: number }>("get_queue");
const playTrackAt = callable<[number], { success: boolean }>("play_track_at");
const setVolume = callable<[number], { success: boolean; volume: number }>("set_volume");
const playMedia = callable<{type: string; id: string}, { success: boolean; error?: string }>("play_media");

interface TrackInfo {
  id: string; title: string; artist: string; album: string;
  artworkUrl: string | null; duration: number;
  catalogId?: string;
}
interface PlayerState {
  isPlaying: boolean; track: TrackInfo | null; position: number;
  volume: number; shuffle: boolean; repeat: "none" | "one" | "all";
  subscription?: { canPlay?: boolean };
}

function formatTime(s: number): string {
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;
}


function getArtUrl(art: any, size: number): string | null {
  if (!art?.url) return null;
  return art.url.replace("{w}", String(size)).replace("{h}", String(size));
}

// --- UA & Identity Spoofing (Anti-Lockout) ---
try {
   console.log("[DeckyAM] Raw Browser UA:", navigator.userAgent);
   const standardUA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
   Object.defineProperty(navigator, 'userAgent', { get: () => standardUA, configurable: true });
   Object.defineProperty(navigator, 'appVersion', { get: () => standardUA, configurable: true });
   Object.defineProperty(navigator, 'platform', { get: () => "Linux x86_64", configurable: true });
   Object.defineProperty(navigator, 'languages', { get: () => ["en-US", "en"], configurable: true });
   console.log("[DeckyAM] Identity Spoofing Active (Linux/Chrome)");
   
   // Probe for plugins to see if Widevine is even visible
   try {
     const plugins = Array.from(navigator.plugins).map(p => p.name).join(", ");
     console.log("[DeckyAM] Browser Plugins:", plugins || "None");
   } catch {}
} catch(e) { console.warn("[DeckyAM] UA Spoofing failed:", e); }

async function checkDRM(): Promise<string> {
  if (!navigator.requestMediaKeySystemAccess) return "API_MISSING";
  
  const configs = [
    { name: "Standard", config: [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }] },
    { name: "Lenient", config: [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4' }] }] }
  ];

  for (const item of configs) {
    try {
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', item.config as any);
      return `WIDEVINE_OK (${item.name})`;
    } catch (e: any) {
      console.warn(`[DeckyAM] ${item.name} DRM failed:`, e.message || e);
    }
  }

  try {
    await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['cenc'] }]);
    return "WIDEVINE_FAILED (ClearKey OK)";
  } catch {
    return "WIDEVINE_FAILED (All DRM Rejected)";
  }
}

let mkInstance: any = null;
let mkLoading = false;

// Module-level caches that survive the QAM panel unmounting/remounting, so
// reopening the QAM shows the last track + art instantly instead of flashing the
// loading screen while the async boot re-runs.
let lastPlayerState: PlayerState | null = null;
let lastStatus: "loading" | "auth" | "ready" | "error" | "needsPlayer" | null = null;

async function loadMusicKit(devToken: string, storefront: string): Promise<any> {
  if (mkInstance) return mkInstance;
  if (mkLoading) {
    await new Promise<void>(resolve => {
      const t = setInterval(() => { if (!mkLoading) { clearInterval(t); resolve(); } }, 200);
    });
    return mkInstance;
  }
  mkLoading = true;
  try {
    const MK = await new Promise<any>(async (resolve, reject) => {
      try {
        if ((window as any).MusicKit) { resolve((window as any).MusicKit); return; }
        const onLoaded = () => resolve((window as any).MusicKit);
        document.addEventListener("musickitloaded", onLoaded, { once: true });
        const res = await fetch("https://js-cdn.music.apple.com/musickit/v3/musickit.js");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const code = await res.text();
        const s = document.createElement("script");
        s.textContent = code;
        document.head.appendChild(s);
        if ((window as any).MusicKit) { document.removeEventListener("musickitloaded", onLoaded); resolve((window as any).MusicKit); return; }
        let n = 0;
        const poll = setInterval(() => {
          n++;
          if ((window as any).MusicKit) { clearInterval(poll); document.removeEventListener("musickitloaded", onLoaded); resolve((window as any).MusicKit); }
          else if (n > 50) { clearInterval(poll); reject(new Error("MusicKit failed to load")); }
        }, 200);
      } catch(e: any) { reject(e); }
    });
    const drm = await checkDRM();
    const canPlayFull = drm.includes("OK");
    
    const configured = await MK.configure({
      developerToken: devToken,
      app: { name: "Decky Apple Music", build: "1.0.0" },
      storefrontId: storefront,
      previewOnly: !canPlayFull,
    });
    // Playback settings (actual playback runs on the backend player daemon).
    try { configured.previewOnly = !canPlayFull; } catch {}
    try { if (configured.player) configured.player.previewOnly = !canPlayFull; } catch {}
    try { configured.playbackConnectivity = 'broadband'; } catch {}
    try { configured.bitrate = 256; } catch {}

    // Route all catalog/library API calls through the player, which holds
    // Apple's harvested token AND rewrites the Origin to music.apple.com. The
    // frontend's own instance can't: that harvested token is origin-locked, so
    // direct calls from Steam's CEF get 401.
    //
    // MusicKit's `api.music` is a read-only, non-configurable own property, so it
    // can't be reassigned, redefined, OR overridden via a Proxy on `api` (the
    // Proxy invariant forces the real value). Instead we override one level up:
    // `mk.api` is an inherited getter, so a Proxy on the instance may return a
    // surrogate `api` object whose `music` is ours and whose other members
    // delegate to the real api. Everything else on the instance passes through to
    // the real object (receiver = target so getters / private #fields work).
    const realApi = configured.api;
    const musicProxy = (path: string, params?: any, options?: any) => amApi(path, params, options);
    const apiSurrogate = new Proxy({ music: musicProxy } as any, {
      get(_t: any, p: any) {
        if (p === "music") return musicProxy;
        const v = (realApi as any)[p];
        return typeof v === "function" ? v.bind(realApi) : v;
      },
    });
    mkInstance = new Proxy(configured, {
      get(t: any, p: any) {
        if (p === "api") return apiSurrogate;
        // Proxy invariant: non-configurable, non-writable own data props must be
        // returned as-is.
        const d = Object.getOwnPropertyDescriptor(t, p);
        if (d && !d.configurable && !d.writable && !("get" in d)) return d.value;
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
      set(t: any, p: any, v: any) {
        try { return Reflect.set(t, p, v, t); } catch (_) { t[p] = v; return true; }
      },
    });
    console.log("[DeckyAM] MusicKit configured (api.music proxied through player).");
    return mkInstance;
  } finally { mkLoading = false; }
}

async function applyMusicUserToken(mk: any, token: string): Promise<void> {
  if (!token || !mk) return;
  if (mk.musicUserToken === token) return;
  
  console.log(`[DeckyAM] Applying MUT (length ${token.length})`);
  const drm = await checkDRM();
  const canPlayFull = drm.includes("OK");
  
  mk.musicUserToken = token;
  mk.previewOnly = !canPlayFull;
  if (mk.player) mk.player.previewOnly = !canPlayFull;
  
  console.log("[DeckyAM] MUT Applied. previewOnly forced to:", mk.previewOnly);
  
  // Force bitrate/quality in case of DRM fallback
  try {
    mk.playbackConnectivity = 'broadband';
    mk.bitrate = 256; 
  } catch {}

  // Verify silently
  (async () => {
    try {
      const drm = await checkDRM();
      console.log("[DeckyAM] %cDRM Status: " + drm, "color: #fa2d48; font-weight: bold;");
      
      const res = await mk.api.music(`/v1/me/library/songs`, { limit: 1 });
      console.log("[DeckyAM] API Authorized:", res?.status === 200);
      
      const sub = mk.musicSubscription;
      console.log("[DeckyAM] Subscription Status:", {
        canPlay: sub?.canPlayCatalogContent,
        hasUsedTrial: sub?.hasUsedCloudLibraryTrial,
        rawSub: sub
      });

      // Listen for playback errors that might explain the 30s limit
      mk.addEventListener('playback-error', (e: any) => {
        console.error("[DeckyAM] %cPlayback Error Detail:", "color: red; font-weight: bold;", e);
      });

    } catch(e: any) {
      console.warn("[DeckyAM] Silent verification check failed:", e.message);
    }
  })();
}

// Network Probe: Intercept fetch to see Apple Music API content
const originalFetch = window.fetch;
(window as any).fetch = async (input: RequestInfo, init?: RequestInit) => {
  const res = await originalFetch(input, init);
  const url = typeof input === 'string' ? input : (input as Request).url;
  if (url.includes('api.music.apple.com/v1/catalog') && url.includes('songs')) {
     const clone = res.clone();
     clone.json().then(data => {
       const song = data?.data?.[0];
       if (song) {
         console.log("[DeckyAM] %cNetwork Probe (Song):", "color: #00ff00;", {
           name: song.attributes?.name,
           canPlay: song.attributes?.playParams?.canPlay,
           hasPreviews: !!song.attributes?.previews
         });
       }
     }).catch(()=>{});
  }
  return res;
};


function getPlayerState(mk: any): PlayerState {
  const p = mk?.player || mk;
  if (!p) return {isPlaying:false,track:null,position:0,volume:1,shuffle:false,repeat:"none"};
  

  
  const item = p.nowPlayingItem;
  const MK = (window as any).MusicKit;
  return {
    isPlaying: p.playbackState === (MK?.PlaybackStates?.playing ?? 3),
    subscription: {
      canPlay: mk.musicSubscription?.canPlayCatalogContent,
    },
    track: item ? {
      id: item.id,
      title: item.attributes?.name ?? "Unknown",
      artist: item.attributes?.artistName ?? "Unknown",
      album: item.attributes?.albumName ?? "Unknown",
      artworkUrl: getArtUrl(item.attributes?.artwork, 300),
      duration: (item.attributes?.durationInMillis ?? 0) / 1000,
    } : null,
    position: p.currentPlaybackTime ?? 0,
    volume: p.volume ?? 1,
    shuffle: p.shuffleMode === (MK?.PlayerShuffleMode?.songs ?? 1),
    repeat: p.repeatMode === (MK?.PlayerRepeatMode?.one ?? 1) ? "one"
           : p.repeatMode === (MK?.PlayerRepeatMode?.all ?? 2) ? "all" : "none",
  };
}

function openSteamBrowser(url: string) {
  try {
    const SC = (window as any).SteamClient;
    // Try various Steam APIs to open a browser
    if (SC?.URL?.ExecuteSteamURL) { SC.URL.ExecuteSteamURL(`steam://openurl/${url}`); return; }
    if (SC?.System?.OpenInSystemBrowser) { SC.System.OpenInSystemBrowser(url); return; }
    if (SC?.URL?.OpenLocalURL) { SC.URL.OpenLocalURL(url); return; }
  } catch(e) { console.error("[DeckyAM] openSteamBrowser error:", e); }
}

const AlbumArt = ({ url, size=56 }: { url: string|null; size?: number }) => (
  <div style={{width:size,height:size,borderRadius:8,background:"rgba(255,255,255,0.08)",flexShrink:0,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"}}>
    {url ? <img src={url} style={{width:"100%",height:"100%",objectFit:"cover"}} />
         : <svg width={size*.4} height={size*.4} viewBox="0 0 24 24" fill="#ffffff44"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>}
  </div>
);

const FocusHighlight = ({ children, onActivate, style, focusWithinClassName, ...props }: any) => {
  const [focused, setFocused] = useState(false);
  const focusStyle = focused ? {
    outline: "2px solid #fa2d48",
    outlineOffset: "-2px",
    boxShadow: "0 0 8px rgba(250, 45, 72, 0.4)",
    background: "rgba(250, 45, 72, 0.1)",
  } : {};

  return (
    <Focusable
      {...props}
      onActivate={onActivate}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        ...style,
        ...focusStyle,
        transition: "all 0.2s ease-in-out",
      }}
    >
      {children}
    </Focusable>
  );
};

const ProgressBar = ({ position, duration, onSeek }: { position:number; duration:number; onSeek:(t:number)=>void }) => {
  const ref = useRef<HTMLDivElement>(null);
  const pct = duration > 0 ? Math.min((position/duration)*100,100) : 0;
  return (
    <div style={{width:"100%",padding:"4px 0"}}>
      <div ref={ref} onClick={e => { if(!ref.current||!duration) return; const r=ref.current.getBoundingClientRect(); onSeek(((e.clientX-r.left)/r.width)*duration); }}
        style={{width:"100%", height:4, background:"rgba(255,255,255,0.15)", borderRadius:2, cursor:"pointer"}}>
        <div style={{width:`${pct}%`, height:"100%", background:"#fa2d48", borderRadius:2}} />
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#ffffff55",marginTop:2}}>
        <span>{formatTime(position)}</span><span>{formatTime(duration)}</span>
      </div>
    </div>
  );
};

const RecentlyPlayedPanel = ({ mk, onPlay }: { mk: any; onPlay?: () => void }) => {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [playLoading, setPlayLoading] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!mk) return;
    setLoading(true);
    try {
      let res = await mk.api.music('/v1/me/recent/played', { limit: 10 });
      let items = res?.data?.data ?? [];
      
      if (items.length === 0) {
        res = await mk.api.music('/v1/me/recent/played/tracks', { limit: 10 });
        items = res?.data?.data ?? [];
      }
      setItems(items);
    } catch(e: any) { 
      console.error("[DeckyAM] Recent-played load error:", e);
    }
    setLoading(false);
  }, [mk]);

  useEffect(() => { fetch(); }, [fetch]);

  const playItem = async (s: any) => {
    const itemType = s.type || "";
    const itemId = s.id || "";
    setPlayLoading(itemId);
    let played = false;
    try {
      if (itemType.includes("album")) {
        const rawUrl = s.attributes?.url;
        const itemUrl = (rawUrl && rawUrl.startsWith("https://")) ? rawUrl : undefined;
        const targetId = s.attributes?.playParams?.catalogId || itemId;
        const res = await playOnBackend({ track_id: targetId, type: itemType, url: itemUrl });
        if (res.success) { played = true; }
        else {
          const res2 = await playMedia({ type: itemType, id: itemId });
          if (res2.success) played = true;
          else toaster.toast({ title: "Apple Music", body: "Play Error: " + (res2.error || "Unknown"), duration: 3000 });
        }
      } else {
        const mediaId = s.attributes?.playParams?.catalogId || itemId;
        const res = await playMedia({ type: itemType, id: mediaId });
        if (res.success) played = true;
        else toaster.toast({ title: "Apple Music", body: "Play Error: " + (res.error || "Unknown"), duration: 3000 });
      }
    } catch(e: any) {
      toaster.toast({ title: "Apple Music", body: "Play Error: " + (e.message || "Unknown"), duration: 3000 });
    }
    setTimeout(() => setPlayLoading(null), 2000);
    if (played && onPlay) setTimeout(() => onPlay(), 500);
  };

  if (loading && items.length === 0) 
    return <div style={{textAlign:"center",color:"#ffffff88",padding:20,fontSize:13}}>Loading Recently Played…</div>;

  return (
    <PanelSection title="Recently Played">
      <Focusable flow-children="horizontal" style={{display:"grid", gridTemplateColumns:"repeat(2, minmax(0, 1fr))", gap:12, padding:"8px 0"}}>
        {items.map((s: any) => (
          <FocusHighlight key={s.id} onActivate={() => playItem(s)} style={{width:"100%", overflow:"hidden", position:"relative", borderRadius: 10}}>
            {playLoading === s.id && (
              <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,zIndex:2,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",borderRadius:10}}>
                <div style={{fontSize:11,color:"#fa2d48",fontWeight:600}}>Opening…</div>
              </div>
            )}
            <div style={{width:"100%", aspectRatio:"1/1", borderRadius:10, overflow:"hidden", background:"rgba(255,255,255,0.05)", boxShadow:"0 4px 12px rgba(0,0,0,0.3)"}}>
              <img src={getArtUrl(s.attributes?.artwork, 300)} style={{width:"100%", height:"100%", objectFit:"cover"}} />
            </div>
            <div style={{marginTop:8}}>
              <div style={{fontSize:12, fontWeight:600, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.name}</div>
              <div style={{fontSize:10, color:"#ffffff66", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.artistName || s.attributes?.curatorName || "Collection"}</div>
            </div>
          </FocusHighlight>
        ))}
      </Focusable>
      {items.length === 0 && !loading && (
        <div style={{padding:40, textAlign:"center", color:"#ffffff44", fontSize:13}}>No recently played items.</div>
      )}
      <PanelSectionRow>
        <FocusHighlight onActivate={fetch} style={{width: "100%", borderRadius: 8}}>
          <ButtonItem layout="below">Refresh</ButtonItem>
        </FocusHighlight>
      </PanelSectionRow>
    </PanelSection>
  );
};

const LibraryItemRow = ({ label, icon, onClick }: { label: string, icon: any, onClick: () => void }) => (
  <PanelSectionRow>
    <FocusHighlight onActivate={onClick} style={{display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 8px", width: "100%", borderRadius: 8}}>
      <div style={{display:"flex", alignItems:"center", gap:12}}>
        <div style={{color:"#fa2d48", display:"flex", alignItems:"center"}}>{icon}</div>
        <div style={{fontSize:14, fontWeight:500, color:"#fff"}}>{label}</div>
      </div>
      <div style={{color:"#ffffff44"}}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
      </div>
    </FocusHighlight>
  </PanelSectionRow>
);

// Navigation request into the library panel (e.g. "Go to Album" from Now Playing)
export interface LibNavTarget { type: "album" | "artist"; id: string; name?: string; }

const isCatalogId = (id: any) => /^\d+$/.test(String(id ?? ""));

type LibView = "home" | "playlists" | "artists" | "albums" | "songs" | "artist-detail" | "album-detail" | "search";

// Distinguish playlists from albums by resource type or id shape
// (playlists: "pl.xxx" catalog / "p.xxx" library; albums: numeric catalog / "l.xxx" library)
const isPlaylistItem = (item: any) => {
  const t = String(item?.type || "");
  const id = String(item?.id || "");
  return t.includes("playlist") || id.startsWith("p.");
};

const LibraryPanel = ({ mk, onPlay, nav, onNavConsumed }: { mk: any; onPlay?: () => void; nav?: LibNavTarget | null; onNavConsumed?: () => void }) => {
  const [view, setView] = useState<LibView>("home");
  const [data, setData] = useState<any[]>([]);
  const [recentlyAdded, setRecentlyAdded] = useState<any[]>([]);
  const [forYou, setForYou] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [playLoading, setPlayLoading] = useState<string | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<any>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<any>(null);
  const [albumTracks, setAlbumTracks] = useState<any[]>([]);
  const [albumBack, setAlbumBack] = useState<LibView>("albums");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<any>(null);
  const [searching, setSearching] = useState(false);

  const fetchHome = useCallback(async () => {
    if (!mk) return;
    setLoading(true);
    try {
      const res = await mk.api.music('/v1/me/library/recently-added', { limit: 6 });
      setRecentlyAdded(res?.data?.data ?? []);
    } catch(e) { console.error("[DeckyAM] Recent load error:", e); }
    setLoading(false);
    // Personal recommendations ("For You") — loaded after the fold, non-blocking
    try {
      const rec = await mk.api.music('/v1/me/recommendations', { limit: 8 });
      const items: any[] = [];
      const seen = new Set<string>();
      for (const group of (rec?.data?.data ?? [])) {
        for (const it of (group.relationships?.contents?.data ?? [])) {
          if (items.length >= 6) break;
          if ((it.type === "albums" || it.type === "playlists") && !seen.has(it.id)) {
            seen.add(it.id);
            items.push(it);
          }
        }
        if (items.length >= 6) break;
      }
      setForYou(items);
    } catch(e) { console.error("[DeckyAM] Recommendations error:", e); }
  }, [mk]);

  const fetchCategory = useCallback(async (cat: string) => {
    if (!mk) return;
    setLoading(true);
    try {
      const res = await mk.api.music(`/v1/me/library/${cat}`, { limit: 50 });
      setData(res?.data?.data ?? []);
    } catch(e) { console.error(`[DeckyAM] ${cat} load error:`, e); }
    setLoading(false);
  }, [mk]);

  const fetchArtistAlbums = useCallback(async (artist: any) => {
    if (!mk) return;
    setLoading(true);
    setSelectedArtist(artist);
    setView("artist-detail");
    setData([]);
    try {
      if (isCatalogId(artist.id)) {
        // Catalog artist (e.g. reached via "Go to Artist" on a catalog song)
        const sf = mk.storefrontId || "us";
        const res = await mk.api.music(`/v1/catalog/${sf}/artists/${artist.id}/albums`, { limit: 50 });
        setData(res?.data?.data ?? []);
      } else {
        // Library artist — fetch albums from the user's library
        const res = await mk.api.music(`/v1/me/library/artists/${artist.id}/albums`, { limit: 50 });
        setData(res?.data?.data ?? []);
      }
    } catch(e) {
      console.error("[DeckyAM] Artist albums error:", e);
      // Fallback: fetch all library albums and filter by artist name
      try {
        const all = await mk.api.music('/v1/me/library/albums', { limit: 100 });
        const filtered = (all?.data?.data ?? []).filter((a: any) =>
          a.attributes?.artistName?.toLowerCase() === artist.attributes?.name?.toLowerCase()
        );
        setData(filtered);
      } catch {}
    }
    setLoading(false);
  }, [mk]);

  // Shared detail view for albums AND playlists (header + Play + tracklist)
  const fetchAlbumDetail = useCallback(async (album: any, backView: LibView = "albums") => {
    if (!mk) return;
    setLoading(true);
    setSelectedAlbum(album);
    setAlbumBack(backView);
    setView("album-detail");
    setAlbumTracks([]);
    try {
      const sf = mk.storefrontId || "us";
      const playlist = isPlaylistItem(album);
      const catalog = playlist ? String(album.id).startsWith("pl.") : isCatalogId(album.id);
      if (catalog) {
        const res = await mk.api.music(`/v1/catalog/${sf}/${playlist ? "playlists" : "albums"}/${album.id}`);
        const d = res?.data?.data?.[0];
        if (d) {
          setSelectedAlbum({ ...album, type: d.type, attributes: d.attributes });
          setAlbumTracks(d.relationships?.tracks?.data ?? []);
        }
      } else {
        const res = await mk.api.music(`/v1/me/library/${playlist ? "playlists" : "albums"}/${album.id}/tracks`, { limit: 100 });
        setAlbumTracks(res?.data?.data ?? []);
      }
    } catch(e) { console.error("[DeckyAM] Detail view error:", e); }
    setLoading(false);
  }, [mk]);

  // Catalog search (songs, artists, albums, playlists) with debounce
  useEffect(() => {
    if (view !== "search") return;
    const term = searchTerm.trim();
    if (term.length < 2) { setSearchResults(null); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const sf = mk?.storefrontId || "us";
        const res = await mk.api.music(`/v1/catalog/${sf}/search`, {
          term, types: "songs,albums,artists,playlists", limit: 6,
        });
        setSearchResults(res?.data?.results ?? {});
      } catch(e) { console.error("[DeckyAM] Search error:", e); }
      setSearching(false);
    }, 500);
    return () => clearTimeout(t);
  }, [searchTerm, view, mk]);

  // Play the current artist's radio station (resolves catalog artist first)
  const playArtistStation = useCallback(async () => {
    if (!mk || !selectedArtist) return;
    const stKey = "station:" + selectedArtist.id;
    setPlayLoading(stKey);
    try {
      const sf = mk.storefrontId || "us";
      let aid = selectedArtist.id;
      if (!isCatalogId(aid)) {
        const r = await mk.api.music(`/v1/me/library/artists/${aid}/catalog`);
        aid = r?.data?.data?.[0]?.id;
      }
      if (!aid) throw new Error("Artist not in catalog");
      const r2 = await mk.api.music(`/v1/catalog/${sf}/artists/${aid}/station`);
      const station = r2?.data?.data?.[0];
      if (!station) throw new Error("No station available");
      const res = await playMedia({ type: "stations", id: station.id });
      if (!res.success) throw new Error(res.error || "Playback failed");
      if (onPlay) setTimeout(() => onPlay(), 500);
    } catch(e: any) {
      console.error("[DeckyAM] Artist station error:", e);
      toaster.toast({ title: "Apple Music", body: "Station error: " + (e?.message || "Unknown"), duration: 3000 });
    }
    setPlayLoading(null);
  }, [mk, selectedArtist, onPlay]);

  useEffect(() => {
    if (view === "home") fetchHome();
    else if (view === "artist-detail" || view === "album-detail" || view === "search") { /* fetched on demand */ }
    else fetchCategory(view);
  }, [view, fetchHome, fetchCategory]);

  // Consume an external navigation request (Go to Album / Go to Artist)
  useEffect(() => {
    if (!nav) return;
    if (nav.type === "album") fetchAlbumDetail({ id: nav.id, attributes: { name: nav.name } }, "home");
    else fetchArtistAlbums({ id: nav.id, attributes: { name: nav.name } });
    onNavConsumed?.();
  }, [nav, fetchAlbumDetail, fetchArtistAlbums]);

  const playItem = async (s: any) => {
    const itemType = s.type || "";
    const itemId = s.id || "";
    setPlayLoading(itemId);

    let played = false;
    try {
      console.log(`[DeckyAM] Playing ${s.attributes?.name} (ID: ${itemId}, Type: ${itemType})`);

      if (itemType.includes("album")) {
        const rawUrl = s.attributes?.url;
        const itemUrl = (rawUrl && rawUrl.startsWith("https://")) ? rawUrl : undefined;
        const targetId = s.attributes?.playParams?.catalogId || itemId;
        const res = await playOnBackend({ track_id: targetId, type: itemType, url: itemUrl });
        if (res.success) { played = true; }
        else {
          const res2 = await playMedia({ type: itemType, id: itemId });
          if (res2.success) played = true;
          else toaster.toast({ title: "Apple Music", body: "Play Error: " + (res2.error || "Unknown"), duration: 3000 });
        }
      } else {
        const mediaId = s.attributes?.playParams?.catalogId || itemId;
        const res = await playMedia({ type: itemType, id: mediaId });
        if (res.success) played = true;
        else toaster.toast({ title: "Apple Music", body: "Play Error: " + (res.error || "Unknown"), duration: 3000 });
      }
    } catch(e: any) {
      console.error("[DeckyAM] Play error detail:", e);
      toaster.toast({ title: "Apple Music", body: "Play Error: " + (e.message || "Unknown"), duration: 3000 });
    }
    setTimeout(() => setPlayLoading(null), 2000);
    if (played && onPlay) setTimeout(() => onPlay(), 500);
  };

  if (loading && recentlyAdded.length === 0 && data.length === 0) 
    return <div style={{textAlign:"center",color:"#ffffff88",padding:20,fontSize:13}}>Loading Library…</div>;

  if (view === "home") {
    return (
      <>
        <PanelSection title="Library">
          <LibraryItemRow label="Search" icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>} onClick={() => { setSearchTerm(""); setSearchResults(null); setView("search"); }} />
          <LibraryItemRow label="Playlists" icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>} onClick={() => setView("playlists")} />
          <LibraryItemRow label="Artists" icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>} onClick={() => setView("artists")} />
          <LibraryItemRow label="Albums" icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>} onClick={() => setView("albums")} />
          <LibraryItemRow label="Songs" icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>} onClick={() => setView("songs")} />
        </PanelSection>

        {forYou.length > 0 && (
          <div style={{marginTop:16}}>
            <div style={{fontSize:16, fontWeight:700, color:"#fff", padding:"0 0 12px 0"}}>For You</div>
            <Focusable flow-children="horizontal" style={{display:"grid", gridTemplateColumns:"repeat(2, minmax(0, 1fr))", gap:12, padding:"0"}}>
              {forYou.map((s: any) => (
                <FocusHighlight key={s.id} onActivate={() => fetchAlbumDetail(s, "home")} style={{width:"100%", overflow:"hidden", position:"relative", borderRadius: 8}}>
                  <div style={{width:"100%", aspectRatio:"1/1", borderRadius:8, overflow:"hidden", background:"rgba(255,255,255,0.05)"}}>
                    <img src={getArtUrl(s.attributes?.artwork, 300) ?? undefined} style={{width:"100%", height:"100%", objectFit:"cover"}} />
                  </div>
                  <div style={{marginTop:6}}>
                    <div style={{fontSize:12, fontWeight:600, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.name}</div>
                    <div style={{fontSize:11, color:"#ffffff88", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.artistName || s.attributes?.curatorName || ""}</div>
                  </div>
                </FocusHighlight>
              ))}
            </Focusable>
          </div>
        )}

        <div style={{marginTop:16, marginBottom:16}}>
          <div style={{fontSize:16, fontWeight:700, color:"#fff", padding:"0 0 12px 0"}}>Recently Added</div>
          {loading && recentlyAdded.length === 0 ? (
             <div style={{padding:"0", color:"#ffffff66", fontSize:12}}>Loading...</div>
          ) : (
            <Focusable flow-children="horizontal" style={{display:"grid", gridTemplateColumns:"repeat(2, minmax(0, 1fr))", gap:12, padding:"0"}}>
              {recentlyAdded.map((s: any) => (
                <FocusHighlight key={s.id} onActivate={() => playItem(s)} style={{width:"100%", overflow:"hidden", position:"relative", borderRadius: 8}}>
                  {playLoading === s.id && (
                    <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,zIndex:2,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",borderRadius:8}}>
                      <div style={{fontSize:11,color:"#fa2d48",fontWeight:600}}>Opening…</div>
                    </div>
                  )}
                  <div style={{width:"100%", aspectRatio:"1/1", borderRadius:8, overflow:"hidden", background:"rgba(255,255,255,0.05)"}}>
                    <img src={getArtUrl(s.attributes?.artwork, 300)} style={{width:"100%", height:"100%", objectFit:"cover"}} />
                  </div>
                  <div style={{marginTop:6}}>
                    <div style={{fontSize:12, fontWeight:600, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.name}</div>
                    <div style={{fontSize:11, color:"#ffffff88", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.artistName || s.attributes?.curatorName}</div>
                  </div>
                </FocusHighlight>
              ))}
            </Focusable>
          )}
        </div>
      </>
    );
  }

  // Catalog search view
  if (view === "search") {
    const sr = searchResults || {};
    const songs = sr.songs?.data ?? [];
    const artists = sr.artists?.data ?? [];
    const albums = sr.albums?.data ?? [];
    const playlists = sr.playlists?.data ?? [];
    const hasResults = songs.length + artists.length + albums.length + playlists.length > 0;
    const rowStyle = {display:"flex", alignItems:"center", gap:10, padding:"5px 8px", cursor:"pointer", position:"relative" as const, width:"100%", borderRadius:8};
    const section = (label: string) => <div style={{fontSize:12, fontWeight:700, color:"#ffffff66", padding:"10px 8px 4px", textTransform:"uppercase" as const, letterSpacing:0.5}}>{label}</div>;
    return (
      <PanelSection title="Search">
        <PanelSectionRow>
          <FocusHighlight onActivate={() => setView("home")} style={{color:"#fa2d48", fontSize:13, fontWeight:600, padding:"8px", cursor:"pointer", display:"flex", alignItems:"center", gap:4, width: "100%", borderRadius: 8}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
            Back to Library
          </FocusHighlight>
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="Search Apple Music"
            value={searchTerm}
            onChange={(e: any) => setSearchTerm(typeof e === "string" ? e : (e?.target?.value ?? ""))}
          />
        </PanelSectionRow>
        {searching && <PanelSectionRow><div style={{color:"#ffffff66",fontSize:12,padding:8}}>Searching…</div></PanelSectionRow>}
        {!searching && searchTerm.trim().length >= 2 && !hasResults && searchResults && (
          <PanelSectionRow><div style={{padding:16, textAlign:"center", color:"#ffffff44", fontSize:13}}>No results.</div></PanelSectionRow>
        )}
        {songs.length > 0 && section("Songs")}
        {songs.map((s: any) => (
          <PanelSectionRow key={s.id}>
            <FocusHighlight onActivate={() => playItem(s)} style={rowStyle}>
              {playLoading === s.id && <div style={{position:"absolute",inset:0,zIndex:2,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.5)",borderRadius:6}}><span style={{fontSize:11,color:"#fa2d48",fontWeight:600}}>Opening…</span></div>}
              <AlbumArt url={getArtUrl(s.attributes?.artwork, 64)} size={36} />
              <div style={{overflow:"hidden",flex:1}}>
                <div style={{fontSize:13, fontWeight:500, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.name}</div>
                <div style={{fontSize:11, color:"#ffffff88", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.artistName}</div>
              </div>
            </FocusHighlight>
          </PanelSectionRow>
        ))}
        {artists.length > 0 && section("Artists")}
        {artists.map((s: any) => (
          <PanelSectionRow key={s.id}>
            <FocusHighlight onActivate={() => fetchArtistAlbums(s)} style={rowStyle}>
              <AlbumArt url={getArtUrl(s.attributes?.artwork, 64)} size={36} />
              <div style={{overflow:"hidden",flex:1}}>
                <div style={{fontSize:13, fontWeight:500, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.name}</div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#ffffff44"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            </FocusHighlight>
          </PanelSectionRow>
        ))}
        {albums.length > 0 && section("Albums")}
        {albums.map((s: any) => (
          <PanelSectionRow key={s.id}>
            <FocusHighlight onActivate={() => fetchAlbumDetail(s, "search")} style={rowStyle}>
              <AlbumArt url={getArtUrl(s.attributes?.artwork, 64)} size={36} />
              <div style={{overflow:"hidden",flex:1}}>
                <div style={{fontSize:13, fontWeight:500, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.name}</div>
                <div style={{fontSize:11, color:"#ffffff88", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.artistName}</div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#ffffff44"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            </FocusHighlight>
          </PanelSectionRow>
        ))}
        {playlists.length > 0 && section("Playlists")}
        {playlists.map((s: any) => (
          <PanelSectionRow key={s.id}>
            <FocusHighlight onActivate={() => fetchAlbumDetail(s, "search")} style={rowStyle}>
              <AlbumArt url={getArtUrl(s.attributes?.artwork, 64)} size={36} />
              <div style={{overflow:"hidden",flex:1}}>
                <div style={{fontSize:13, fontWeight:500, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.name}</div>
                <div style={{fontSize:11, color:"#ffffff88", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.curatorName || ""}</div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#ffffff44"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            </FocusHighlight>
          </PanelSectionRow>
        ))}
      </PanelSection>
    );
  }

  // Album / playlist detail view — artwork header, Play, tracklist (iOS-style)
  if (view === "album-detail" && selectedAlbum) {
    const attrs = selectedAlbum.attributes || {};
    const isPl = isPlaylistItem(selectedAlbum);
    const backLabel = albumBack === "artist-detail" ? "Back to Artist"
      : albumBack === "search" ? "Back to Search"
      : albumBack === "playlists" ? "Back to Playlists"
      : albumBack === "home" ? "Back to Library" : "Back to Albums";
    return (
      <PanelSection title={attrs.name || (isPl ? "Playlist" : "Album")}>
        <PanelSectionRow>
          <FocusHighlight onActivate={() => { setView(albumBack); setSelectedAlbum(null); }} style={{color:"#fa2d48", fontSize:13, fontWeight:600, padding:"8px", cursor:"pointer", display:"flex", alignItems:"center", gap:4, width: "100%", borderRadius: 8}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
            {backLabel}
          </FocusHighlight>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{display:"flex", alignItems:"center", gap:12, padding:"4px 8px"}}>
            <AlbumArt url={getArtUrl(attrs.artwork, 200)} size={72} />
            <div style={{overflow:"hidden", flex:1}}>
              <div style={{fontSize:14, fontWeight:700, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{attrs.name || ""}</div>
              <div style={{fontSize:12, color:"#ffffff88", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{attrs.artistName || attrs.curatorName || ""}</div>
              {(attrs.releaseDate || albumTracks.length > 0) && <div style={{fontSize:11, color:"#ffffff55"}}>{attrs.releaseDate ? String(attrs.releaseDate).slice(0,4) : ""}{albumTracks.length ? `${attrs.releaseDate ? " · " : ""}${albumTracks.length} songs` : ""}</div>}
            </div>
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <FocusHighlight onActivate={() => playItem({ id: selectedAlbum.id, type: isPl ? (String(selectedAlbum.id).startsWith("pl.") ? "playlists" : "library-playlists") : (isCatalogId(selectedAlbum.id) ? "albums" : "library-albums"), attributes: attrs })} style={{display:"flex", alignItems:"center", justifyContent:"center", gap:6, background:"#fa2d48", borderRadius:8, padding:"8px 0", width:"100%", cursor:"pointer", position:"relative"}}>
            {playLoading === selectedAlbum.id && <div style={{position:"absolute",inset:0,zIndex:2,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.5)",borderRadius:8}}><span style={{fontSize:11,color:"#fff",fontWeight:600}}>Opening…</span></div>}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
            <span style={{fontSize:13, fontWeight:700, color:"#fff"}}>{isPl ? "Play Playlist" : "Play Album"}</span>
          </FocusHighlight>
        </PanelSectionRow>
        {loading && <PanelSectionRow><div style={{color:"#ffffff66",fontSize:12,padding:8}}>Loading tracks…</div></PanelSectionRow>}
        {albumTracks.map((t: any, i: number) => (
          <PanelSectionRow key={t.id || i}>
            <FocusHighlight onActivate={() => playItem({ id: t.attributes?.playParams?.catalogId || t.id, type: "songs", attributes: t.attributes })} style={{display:"flex", alignItems:"center", gap:10, padding:"5px 8px", cursor:"pointer", position:"relative", width:"100%", borderRadius:8}}>
              {playLoading === (t.attributes?.playParams?.catalogId || t.id) && <div style={{position:"absolute",inset:0,zIndex:2,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.5)",borderRadius:6}}><span style={{fontSize:11,color:"#fa2d48",fontWeight:600}}>Opening…</span></div>}
              <div style={{width:20, textAlign:"right", fontSize:12, color:"#ffffff55", flexShrink:0}}>{t.attributes?.trackNumber ?? i + 1}</div>
              <div style={{overflow:"hidden", flex:1}}>
                <div style={{fontSize:13, fontWeight:500, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{t.attributes?.name}</div>
              </div>
              <div style={{fontSize:10, color:"#ffffff44", whiteSpace:"nowrap"}}>{t.attributes?.durationInMillis ? `${Math.floor(t.attributes.durationInMillis/60000)}:${String(Math.floor((t.attributes.durationInMillis%60000)/1000)).padStart(2,'0')}` : ""}</div>
            </FocusHighlight>
          </PanelSectionRow>
        ))}
        {albumTracks.length === 0 && !loading && (
          <PanelSectionRow>
            <div style={{padding:20, textAlign:"center", color:"#ffffff44", fontSize:13}}>No tracks found.</div>
          </PanelSectionRow>
        )}
      </PanelSection>
    );
  }

  // Artist detail view — show their albums
  if (view === "artist-detail" && selectedArtist) {
    return (
      <PanelSection title={selectedArtist.attributes?.name || "Artist"}>
        <PanelSectionRow>
          <FocusHighlight onActivate={() => { setView("artists"); setSelectedArtist(null); }} style={{color:"#fa2d48", fontSize:13, fontWeight:600, padding:"8px", cursor:"pointer", display:"flex", alignItems:"center", gap:4, width: "100%", borderRadius: 8}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
            Back to Artists
          </FocusHighlight>
        </PanelSectionRow>
        <PanelSectionRow>
          <FocusHighlight onActivate={playArtistStation} style={{display:"flex", alignItems:"center", justifyContent:"center", gap:6, background:"rgba(250,45,72,0.15)", border:"1px solid rgba(250,45,72,0.4)", borderRadius:8, padding:"7px 0", width:"100%", cursor:"pointer", position:"relative"}}>
            {playLoading === "station:" + selectedArtist.id && <div style={{position:"absolute",inset:0,zIndex:2,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.5)",borderRadius:8}}><span style={{fontSize:11,color:"#fa2d48",fontWeight:600}}>Opening…</span></div>}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="#fa2d48"><path d="M3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.11-.89-2-2-2H8.3l8.26-3.34L15.88 1 3.24 6.15zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-2h-2v2H4V8h16v4z"/></svg>
            <span style={{fontSize:13, fontWeight:700, color:"#fa2d48"}}>Play Station</span>
          </FocusHighlight>
        </PanelSectionRow>
        {loading && <PanelSectionRow><div style={{color:"#ffffff66",fontSize:12,padding:8}}>Loading albums…</div></PanelSectionRow>}
        {data.map((s: any) => (
          <PanelSectionRow key={s.id}>
            <FocusHighlight onActivate={() => fetchAlbumDetail(s, "artist-detail")} style={{display:"flex", alignItems:"center", gap:10, padding:"6px 8px", cursor:"pointer", position:"relative", width: "100%", borderRadius: 8}}>
              <AlbumArt url={getArtUrl(s.attributes?.artwork, 64)} size={40} />
              <div style={{overflow:"hidden",flex:1}}>
                <div style={{fontSize:13, fontWeight:600, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.name}</div>
                <div style={{fontSize:11, color:"#ffffff88", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.artistName}</div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#ffffff44"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            </FocusHighlight>
          </PanelSectionRow>
        ))}
        {data.length === 0 && !loading && (
          <PanelSectionRow>
            <div style={{padding:20, textAlign:"center", color:"#ffffff44", fontSize:13}}>No albums found.</div>
          </PanelSectionRow>
        )}
      </PanelSection>
    );
  }

  return (
    <PanelSection title={view.charAt(0).toUpperCase() + view.slice(1)}>
      <PanelSectionRow>
        <FocusHighlight onActivate={() => setView("home")} style={{color:"#fa2d48", fontSize:13, fontWeight:600, padding:"8px", cursor:"pointer", display:"flex", alignItems:"center", gap:4, width: "100%", borderRadius: 8}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          Back to Library
        </FocusHighlight>
      </PanelSectionRow>
      {data.map((s: any) => (
        <PanelSectionRow key={s.id}>
          <FocusHighlight
            onActivate={() => view === "artists" ? fetchArtistAlbums(s) : view === "albums" ? fetchAlbumDetail(s, "albums") : view === "playlists" ? fetchAlbumDetail(s, "playlists") : playItem(s)}
            style={{display:"flex", alignItems:"center", gap:10, padding:"6px 8px", cursor:"pointer", position:"relative", width: "100%", borderRadius: 8}}
          >
            {playLoading === s.id && <div style={{position:"absolute",inset:0,zIndex:2,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.5)",borderRadius:6}}><span style={{fontSize:11,color:"#fa2d48",fontWeight:600}}>Opening…</span></div>}
            <AlbumArt url={getArtUrl(s.attributes?.artwork, 64)} size={40} />
            <div style={{overflow:"hidden",flex:1}}>
              <div style={{fontSize:13, fontWeight:600, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.name}</div>
              <div style={{fontSize:11, color:"#ffffff88", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{s.attributes?.artistName}</div>
            </div>
            {(view === "artists" || view === "albums" || view === "playlists") && (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#ffffff44"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            )}
            {view === "songs" && (
              <div style={{fontSize:10,color:"#ffffff44",whiteSpace:"nowrap"}}>{s.attributes?.durationInMillis ? `${Math.floor(s.attributes.durationInMillis/60000)}:${String(Math.floor((s.attributes.durationInMillis%60000)/1000)).padStart(2,'0')}` : ""}</div>
            )}
          </FocusHighlight>
        </PanelSectionRow>
      ))}
      {data.length === 0 && !loading && (
        <PanelSectionRow>
          <div style={{padding:20, textAlign:"center", color:"#ffffff44", fontSize:13}}>No {view} found.</div>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
};

// Apple ID sign-in typed directly in the QAM (Steam's on-screen keyboard works
// in these fields). Email + password are sent to the backend, which drives
// Apple's hidden login window; if Apple asks for a 2FA code we prompt for it.
const fieldStyle: React.CSSProperties = {
  width:"100%", background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.15)",
  borderRadius:8, color:"#fff", padding:"8px 10px", fontSize:12, outline:"none",
  marginBottom:8, boxSizing:"border-box",
};
const asStr = (e:any) => typeof e === "string" ? e : (e?.target?.value ?? "");
const SignInForm = ({ onSuccess }: { onSuccess: () => void }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"creds" | "2fa">("creds");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submitCreds = async () => {
    if (busy) return;
    if (!email.trim() || !password) { setError("Enter your Apple ID and password."); return; }
    setBusy(true); setError("");
    try {
      const r = await amLogin({ email: email.trim(), password });
      if (r?.step === "signedin") { onSuccess(); return; }
      if (r?.step === "2fa") { setPhase("2fa"); setCode(""); }
      else { setError(r?.error || "Sign-in failed. Check your Apple ID and password."); }
    } catch (e: any) { setError(e?.message || "Sign-in failed."); }
    setBusy(false);
  };

  const submitCode = async () => {
    if (busy) return;
    const c = code.replace(/\D/g, "");
    if (c.length < 6) { setError("Enter the 6-digit verification code."); return; }
    setBusy(true); setError("");
    try {
      const r = await amSubmit2fa({ code: c });
      if (r?.step === "signedin") { onSuccess(); return; }
      setError(r?.error || "Code not accepted — try again.");
      setCode("");
    } catch (e: any) { setError(e?.message || "Verification failed."); }
    setBusy(false);
  };

  const RedButton = ({ label, onActivate }: { label: string, onActivate: () => void }) => (
    <FocusHighlight onActivate={busy ? () => {} : onActivate}
      style={{display:"flex",justifyContent:"center",background: busy ? "#7a2733" : "#fa2d48",borderRadius:8,padding:"9px 0",width:"100%",cursor: busy ? "default" : "pointer",marginBottom:6}}>
      <span style={{fontSize:13,fontWeight:700,color:"#fff"}}>{busy ? "Working…" : label}</span>
    </FocusHighlight>
  );

  return (
    <div>
      {phase === "creds" ? (
        <>
          <div style={{fontSize:12,color:"#ffffff99",marginBottom:4}}>Apple ID</div>
          <TextField value={email} onChange={(e:any)=>setEmail(asStr(e))} style={fieldStyle} />
          <div style={{fontSize:12,color:"#ffffff99",marginBottom:4}}>Password</div>
          <TextField value={password} bIsPassword={true} onChange={(e:any)=>setPassword(asStr(e))} style={fieldStyle} />
          <RedButton label="Sign In" onActivate={submitCreds} />
        </>
      ) : (
        <>
          <div style={{fontSize:12,color:"#ffffff99",marginBottom:8,lineHeight:1.5}}>
            Enter the 6-digit verification code sent to your trusted Apple device.
          </div>
          <TextField value={code} onChange={(e:any)=>setCode(asStr(e).replace(/\D/g,"").slice(0,6))} style={fieldStyle} />
          <RedButton label="Verify" onActivate={submitCode} />
          <FocusHighlight onActivate={()=>{ if(!busy){ setPhase("creds"); setError(""); } }}
            style={{display:"flex",justifyContent:"center",padding:"4px 0",width:"100%",cursor:"pointer"}}>
            <span style={{fontSize:11,color:"#ffffff88"}}>Start over</span>
          </FocusHighlight>
        </>
      )}
      {error ? <div style={{fontSize:11,color:"#ff6b6b",marginTop:4,lineHeight:1.4}}>{error}</div> : null}
    </div>
  );
};

// Shared red, rounded action button used throughout Settings for a consistent
// look with the Sign In button.
const RedActionButton = ({ label, onActivate }: { label: string, onActivate: () => void }) => (
  <FocusHighlight onActivate={onActivate}
    style={{display:"flex",justifyContent:"center",background:"#fa2d48",borderRadius:8,padding:"9px 0",width:"100%",cursor:"pointer",marginBottom:8}}>
    <span style={{fontSize:13,fontWeight:700,color:"#fff"}}>{label}</span>
  </FocusHighlight>
);

const AuthScreen = ({ onSettings, onSignedIn }: { onSettings: () => void, onSignedIn: () => void }) => {
  return (
    <PanelSection title="Apple Music">
      <PanelSectionRow>
        <div style={{fontSize:12,color:"#ffffff99",marginBottom:12,lineHeight:1.5}}>
          Sign in with your Apple ID to start listening — no developer token needed.
        </div>
        <SignInForm onSuccess={onSignedIn} />
        <FocusHighlight onActivate={onSettings} style={{width: "100%", borderRadius: 8, marginTop: 4}}>
          <ButtonItem layout="below">Settings</ButtonItem>
        </FocusHighlight>
      </PanelSectionRow>
    </PanelSection>
  );
};

// First-run screen: download + install the large Electron player payload.
const InstallPlayerScreen = ({ onDone }: { onDone: () => void }) => {
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const pollRef = useRef<any>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const start = async () => {
    if (busy) return;
    setBusy(true); setErr(""); setPct(0); setMsg("Starting…");
    try { await installPlayer(); }
    catch (e: any) { setErr(e?.message || "Couldn't start install"); setBusy(false); return; }
    pollRef.current = setInterval(async () => {
      try {
        const st = await installStatus();
        setPct(st?.pct || 0); setMsg(st?.message || "");
        if (st?.state === "done") {
          if (pollRef.current) clearInterval(pollRef.current);
          setBusy(false); onDone();
        } else if (st?.state === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
          setBusy(false); setErr(st?.message || "Install failed");
        }
      } catch {}
    }, 700);
  };

  return (
    <PanelSection title="Apple Music">
      <PanelSectionRow>
        <div style={{fontSize:13,color:"#fff",fontWeight:700,marginBottom:6}}>Player setup</div>
        <div style={{fontSize:12,color:"#ffffff99",marginBottom:12,lineHeight:1.5}}>
          Download the Apple Music player (~120 MB) — the media engine that enables
          full-length playback. Keep the Deck online and the plugin open until it finishes.
        </div>
        {!busy ? (
          <RedActionButton label={err ? "Retry install" : "Install Player"} onActivate={start} />
        ) : (
          <div style={{marginBottom:8}}>
            <div style={{fontSize:12,color:"#fff",marginBottom:6}}>{msg || "Working…"}</div>
            <div style={{width:"100%",height:8,borderRadius:4,background:"rgba(255,255,255,0.12)",overflow:"hidden"}}>
              <div style={{width:`${Math.max(2,pct)}%`,height:"100%",background:"#fa2d48",transition:"width 0.3s"}} />
            </div>
            <div style={{fontSize:11,color:"#ffffff77",marginTop:4,textAlign:"right"}}>{pct}%</div>
          </div>
        )}
        {err ? <div style={{fontSize:11,color:"#ff6b6b",marginTop:6,lineHeight:1.4}}>{err}</div> : null}
      </PanelSectionRow>
    </PanelSection>
  );
};

const QueueList = () => {
  const [tracks, setTracks] = useState<{id:string;title:string;artist:string;duration:number;artworkUrl:string;trackNumber:number}[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const q = await getQueue();
        if (active && q) {
          setTracks(q.tracks || []);
          setCurrentIndex(q.currentIndex ?? -1);
        }
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { active = false; clearInterval(iv); };
  }, []);

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };

  if (tracks.length === 0) return null;

  return (
    <div style={{marginTop:12,borderTop:"1px solid rgba(255,255,255,0.1)",paddingTop:8}}>
      <div style={{fontSize:12,color:"#ffffff55",marginBottom:6,fontWeight:600}}>TRACKLIST</div>
      <div style={{padding: "0 6px"}}>
        {tracks.map((t, i) => (
          <FocusHighlight
            key={t.id || i}
            onActivate={async () => { try { await playTrackAt(i); } catch {} }}
            style={{
              display:"flex",alignItems:"center",gap:6,padding:"6px 2px",
              borderRadius:6,cursor:"pointer", width: "100%",
              background: i === currentIndex ? "rgba(250,45,72,0.15)" : "transparent",
            }}
          >
            <div style={{width:20,textAlign:"right",fontSize:11,color: i === currentIndex ? "#fa2d48" : "#ffffff44",fontWeight: i === currentIndex ? 700 : 400, paddingRight: 4, flexShrink: 0}}>
              {i === currentIndex ? "▶" : t.trackNumber}
            </div>
            <div style={{flex:1,overflow:"hidden", paddingRight: 8}}>
              <div style={{fontSize:12,color: i === currentIndex ? "#fa2d48" : "#fff",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",fontWeight: i === currentIndex ? 600 : 400}}>
                {t.title}
              </div>
              <div style={{fontSize:10,color:"#ffffff55",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.artist}</div>
            </div>
            <div style={{fontSize:10,color:"#ffffff44",whiteSpace:"nowrap", paddingRight: 12, flexShrink: 0}}>{fmtTime(t.duration)}</div>
          </FocusHighlight>
        ))}
      </div>
    </div>
  );
};

const Content = () => {
  const [status, setStatus] = useState<"loading"|"auth"|"ready"|"error"|"needsPlayer">(() => lastStatus ?? "loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [mk, setMk] = useState<any>(() => (window as any).GlobalMusicKit || mkInstance || null);
  const [player, setPlayer] = useState<PlayerState>(() => lastPlayerState ?? {isPlaying:false,track:null,position:0,volume:1,shuffle:false,repeat:"none"});
  const [tab, setTab] = useState<"player"|"library"|"recent">("player");
  const [libNav, setLibNav] = useState<LibNavTarget | null>(null);
  const [navLoading, setNavLoading] = useState<"album"|"artist"|null>(null);
  const [trackToasts, setTrackToasts] = useState(true);
  const [autoplay, setAutoplayState] = useState(false);
  const [musicTrimDb, setMusicTrimDb] = useState(-8);
  const [duckEnabled, setDuckEnabled] = useState(false);
  const [duckDepth, setDuckDepth] = useState(0.0);
  const [duckRelease, setDuckRelease] = useState(2500);
  const [duckAttack, setDuckAttack] = useState(45);
  const [loved, setLoved] = useState(false);
  const [inLib, setInLib] = useState(false);
  const [actionBusy, setActionBusy] = useState<"love"|"add"|null>(null);
  const lastToastKey = useRef("");
  const volumeHoldRef = useRef(0);
  const lastVolSendRef = useRef(0);
  const volTrailRef = useRef<any>(null);

  // Persist status + now-playing to module scope so a QAM reopen restores them
  // instantly (see lastPlayerState / lastStatus).
  useEffect(() => { lastStatus = status; }, [status]);
  useEffect(() => { lastPlayerState = player; }, [player]);

  // Apply a volume change: update the slider instantly (so it feels exact even
  // at 1% steps), but throttle the backend/CDP call to ~15/s and always send
  // the final value, so a fast touch-drag stays smooth instead of flooding it.
  const applyVolume = useCallback((v: number) => {
    const vol = Math.max(0, Math.min(1, v));
    volumeHoldRef.current = Date.now();
    setPlayer(p => ({ ...p, volume: vol }));
    const send = () => { lastVolSendRef.current = Date.now(); setVolume(vol).catch(() => {}); };
    const since = Date.now() - lastVolSendRef.current;
    if (volTrailRef.current) clearTimeout(volTrailRef.current);
    if (since >= 66) send();
    else volTrailRef.current = setTimeout(send, 66 - since);
  }, []);

  const [showSettings, setShowSettings] = useState(false);
  const [tokenInput] = useState("");
  const [sfInput, setSfInput] = useState(DEFAULT_STOREFRONT);
  const [mutInput, setMutInput] = useState("");
  const pollRef = useRef<any>(null);

  useEffect(() => {
    const styleId = "deckyam-focus-styles";
    if (!document.getElementById(styleId)) {
      const s = document.createElement("style");
      s.id = styleId;
      s.textContent = `
        .gpfocus {
          outline: 2px solid #fa2d48 !important;
          outline-offset: -2px;
          box-shadow: 0 0 8px rgba(250, 45, 72, 0.4) !important;
          background: rgba(250, 45, 72, 0.1) !important;
          transition: all 0.2s ease-in-out;
        }
      `;
      document.head.appendChild(s);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Gamepad button 2 is 'X' on Steam Deck
      if ((e as any).button === 2 || e.key === 'x' || e.key === 'X') {
        mprisPlayPause().catch(() => {});
      }
      
      // L1 (4) and R1 (5) for tab switching
      const tabs: ("player" | "library" | "recent")[] = ["player", "library", "recent"];
      if ((e as any).button === 4) { // L1
        setTab(prev => {
          const idx = tabs.indexOf(prev);
          return tabs[(idx - 1 + tabs.length) % tabs.length];
        });
      }
      if ((e as any).button === 5) { // R1
        setTab(prev => {
          const idx = tabs.indexOf(prev);
          return tabs[(idx + 1) % tabs.length];
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const boot = useCallback(async (sf: string, mut: string) => {
    setStatus("loading");
    setErrorMsg("");
    try {
      const devToken = await getDevToken();
      if (!devToken) throw new Error("Player not ready — couldn't get Apple token");
      const instance = await loadMusicKit(devToken, sf);
      if (mut) {
        try {
          await applyMusicUserToken(instance, mut);
          setMk(instance);
          setStatus("ready");
          setPlayer(getPlayerState(instance));
          return instance;
        } catch(e: any) {
          console.warn("[DeckyAM] Saved token invalid:", e.message);
        }
      }
      setMk(instance);
      setStatus("auth");
      return instance;
    } catch(e: any) {
      setErrorMsg(e.message ?? "Unknown error");
      setStatus("error");
      return null;
    }
  }, []);

  const initPlugin = useCallback(async () => {
      try {
        // First run: the large Electron player is downloaded on demand and may
        // not be installed yet. Gate everything else on it being present.
        try {
          const pi = await playerInstalled();
          const needsInstall = !pi?.installed;
          // Only treat a known, differing version as an update (empty = legacy
          // manual install → leave it alone).
          const needsUpdate = !!pi?.installed && !!pi?.version && !!pi?.latest && pi.version !== pi.latest;
          if (needsInstall || needsUpdate) { setStatus("needsPlayer"); return; }
        } catch {}
        const s = await getSettings();
        const sf = (typeof s.storefront === 'string' && s.storefront) ? s.storefront : DEFAULT_STOREFRONT;

        let mut = (typeof s.musicUserToken === 'string') ? s.musicUserToken : "";
        if (!mut) mut = window.localStorage.getItem('apple-music-user-token') || "";

        setSfInput(sf); setMutInput(mut);
        setTrackToasts(s.trackToasts ?? true);
        setAutoplayState((s as any).autoplay ?? false);
        setMusicTrimDb((s as any).musicTrimDb ?? -8);
        setDuckEnabled((s as any).duckEnabled ?? false);
        setDuckDepth((s as any).duckDepth ?? 0.0);
        setDuckRelease((s as any).duckRelease ?? 2500);
        setDuckAttack((s as any).duckAttack ?? 45);
        
        if (mut && (!s.musicUserToken || s.musicUserToken !== mut)) {
           console.log("[DeckyAM] Synchronizing token to backend settings...");
           await saveSettings({ developerToken: "", storefront: sf, musicUserToken: mut });
        }
        
        // Use global instance if available
        if ((window as any).GlobalMusicKit) {
           const gm = (window as any).GlobalMusicKit;
           if (mut) {
             try { await applyMusicUserToken(gm, mut); } catch(e){}
           }
           setMk(gm);
           setStatus(mut ? "ready" : "auth");
           // Only seed from the frontend instance if we don't already have a
           // cached now-playing (the daemon, not this instance, is what plays —
           // the status poll below repopulates from it). Avoids blanking the
           // restored art/info on a QAM reopen.
           const ps = getPlayerState(gm);
           if (ps.track || !player.track) setPlayer(ps);
           (window as any).mk = gm;
        } else {
           const musicInst = await boot(sf, mut);
           (window as any).mk = musicInst;
        }
        console.log("[DeckyAM] Booted and settings loaded. window.mk is ready.");
      } catch(e: any) {
        console.error("[DeckyAM] Settings/Boot failed:", e);
        const errMk = await boot(DEFAULT_STOREFRONT, "");
        (window as any).mk = errMk;
      }
  }, [boot]);

  useEffect(() => {
    initPlugin();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [initPlugin]);

  useEffect(() => {
    if (status !== "ready") return;
    if (pollRef.current) clearInterval(pollRef.current);
    const pollOnce = async () => {
      try {
        const st = await mprisGetStatus();
        // Don't let a poll that was already in flight clobber a volume the user
        // just set; keep the local value for a short window after any change.
        const holding = Date.now() - volumeHoldRef.current < 1500;
        if (st && st.track) {
          setPlayer(p => ({
            isPlaying: st.playing,
            subscription: p.subscription,
            track: {
              id: st.track!.id || "",
              catalogId: st.track!.catalogId || "",
              title: st.track!.title || "Unknown",
              artist: st.track!.artist || "",
              album: st.track!.album || "",
              artworkUrl: st.track!.artworkUrl || null,
              duration: st.track!.duration || 0,
            },
            position: st.position || 0,
            volume: holding ? p.volume : ((st as any).volume ?? p.volume),
            shuffle: st.shuffle ?? false,
            repeat: st.repeat === 1 ? "one" : st.repeat === 2 ? "all" : "none",
          }));
        } else if (st) {
          setPlayer(p => ({ ...p, isPlaying: st.playing, position: st.position || 0, volume: holding ? p.volume : ((st as any).volume ?? p.volume), shuffle: st.shuffle ?? p.shuffle, repeat: st.repeat === 1 ? "one" : st.repeat === 2 ? "all" : "none" }));
        }
      } catch {}
    };
    pollOnce(); // fetch immediately so a reopen refreshes without a 2s wait
    pollRef.current = setInterval(pollOnce, 2000);
    return () => clearInterval(pollRef.current);
  }, [status]);

  // iOS-style lock-screen banner: toast when the track changes (if enabled).
  // NOTE: must stay above the early returns below — hooks can't be conditional.
  useEffect(() => {
    const t = player.track;
    if (!t?.title) return;
    const key = t.title + "|" + t.artist;
    if (lastToastKey.current && lastToastKey.current !== key && player.isPlaying && trackToasts) {
      toaster.toast({ title: t.title, body: t.artist + (t.album ? " — " + t.album : ""), duration: 4000 });
    }
    lastToastKey.current = key;
  }, [player.track?.title, player.track?.artist, player.isPlaying, trackToasts]);

  // Refresh Favorite / In-Library state when the track changes.
  useEffect(() => {
    const t: any = player.track;
    const id = t?.catalogId || t?.id;
    setLoved(false); setInLib(false);
    if (!id || !mk || !/^\d+$/.test(String(id))) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await mk.api.music(`/v1/me/ratings/songs/${id}`);
        if (!cancelled) setLoved(r?.data?.data?.[0]?.attributes?.value === 1);
      } catch {} // 404 = not rated
      try {
        const sf = mk.storefrontId || "us";
        const r = await mk.api.music(`/v1/catalog/${sf}/songs/${id}`, { include: "library" });
        const lib = r?.data?.data?.[0]?.relationships?.library?.data ?? [];
        if (!cancelled) setInLib(lib.length > 0);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [player.track?.id, (player.track as any)?.catalogId, mk]);

  const handleToken = async (mut: string) => {
    if (!mk) return;
    try {
      await applyMusicUserToken(mk, mut);
      setMutInput(mut);
      await saveSettings({ developerToken: tokenInput, storefront: sfInput, musicUserToken: mut });
      setStatus("ready");
      setPlayer(getPlayerState(mk));
      toaster.toast({ title:"Apple Music", body:"Connected! 🎵", duration:3000 });
    } catch(e: any) {
      toaster.toast({ title:"Apple Music", body:"Token error: " + e.message, duration:5000 });
      setStatus("auth");
    }
  };


  // Apple ID sign-in now happens in-QAM via <SignInForm> (email/password/2FA
  // typed here, driven into Apple's hidden login by the backend). On success the
  // backend has captured & persisted the user token; pull it and apply it.
  const handleSignedIn = async () => {
    try {
      const s = await getSettings();
      setMutInput(s.musicUserToken || "");
      if (mk && s.musicUserToken) { try { await applyMusicUserToken(mk, s.musicUserToken); } catch {} }
    } catch {}
    setStatus("ready");
    setShowSettings(false);
    toaster.toast({ title: "Apple Music", body: "Signed in! 🎵", duration: 3000 });
  };

  const isSignedIn = status === "ready" || !!mutInput;
  if (showSettings) return (
    <PanelSection title="Settings">
      <PanelSectionRow>
        {!isSignedIn ? (
          <>
            <div style={{fontSize:13,color:"#fff",fontWeight:700,marginBottom:6}}>Apple ID sign-in</div>
            <SignInForm onSuccess={handleSignedIn} />
            <div style={{fontSize:10,color:"#ffffff55",margin:"2px 0 12px"}}>Signs in with Apple's own developer token — none needed from you.</div>
          </>
        ) : (
          <div style={{fontSize:12,color:"#ffffff99",marginBottom:12,display:"flex",alignItems:"center",gap:6}}>
            <span style={{color:"#1db954",fontWeight:700}}>✓</span> Signed in to Apple Music
          </div>
        )}
        <FocusHighlight onActivate={async () => {
          const next = !trackToasts;
          setTrackToasts(next);
          try { await saveSettings({ developerToken: tokenInput, storefront: sfInput, musicUserToken: mutInput, trackToasts: next }); } catch {}
        }} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px",borderRadius:8,cursor:"pointer",marginBottom:8,border:"1px solid rgba(255,255,255,0.1)"}}>
          <div style={{fontSize:13,color:"#fff"}}>Song change notifications</div>
          <div style={{width:36,height:20,borderRadius:10,background:trackToasts?"#fa2d48":"rgba(255,255,255,0.15)",position:"relative",transition:"background 0.2s"}}>
            <div style={{width:16,height:16,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:trackToasts?18:2,transition:"left 0.2s"}} />
          </div>
        </FocusHighlight>

        <FocusHighlight onActivate={async () => {
          const next = !autoplay;
          setAutoplayState(next);
          try { await setAutoplay(next); } catch {}
        }} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px",borderRadius:8,cursor:"pointer",marginBottom:8,border:"1px solid rgba(255,255,255,0.1)"}}>
          <div>
            <div style={{fontSize:13,color:"#fff"}}>Autoplay similar songs</div>
            <div style={{fontSize:10,color:"#ffffff66",marginTop:2}}>Keep playing related tracks after an album or playlist ends</div>
          </div>
          <div style={{width:36,height:20,borderRadius:10,background:autoplay?"#fa2d48":"rgba(255,255,255,0.15)",position:"relative",flexShrink:0,transition:"background 0.2s"}}>
            <div style={{width:16,height:16,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:autoplay?18:2,transition:"left 0.2s"}} />
          </div>
        </FocusHighlight>

        <div style={{marginTop:6,marginBottom:8,padding:"10px",borderRadius:8,border:"1px solid rgba(255,255,255,0.1)"}}>
          <div style={{fontSize:13,color:"#fff",fontWeight:600}}>Music level</div>
          <div style={{fontSize:10,color:"#ffffff66",marginTop:2,marginBottom:4}}>Lower music to better match game loudness</div>
          <div style={{fontSize:11,color:"#ffffff99",display:"flex",justifyContent:"space-between"}}><span>Trim</span><span>{musicTrimDb === 0 ? "0 dB" : "−" + Math.abs(musicTrimDb) + " dB"}</span></div>
          <FocusHighlight style={{display:"flex",alignItems:"center",padding:"2px 0"}}>
            <input type="range" min={-16} max={0} step={1} value={musicTrimDb}
              onInput={(e:React.FormEvent<HTMLInputElement>)=>setMusicTrimDb(parseFloat((e.target as HTMLInputElement).value))}
              onChange={(e:React.ChangeEvent<HTMLInputElement>)=>{ const db=parseFloat(e.target.value); setMusicTrimDb(db); setMusicTrim({ db, volume: player.volume }).catch(()=>{}); }}
              style={{flex:1,accentColor:"#fa2d48",height:4}} />
          </FocusHighlight>
        </div>

        <div style={{marginTop:6,marginBottom:8,padding:"10px",borderRadius:8,border:"1px solid rgba(255,255,255,0.1)"}}>
          <FocusHighlight onActivate={async () => {
            const next = !duckEnabled;
            setDuckEnabled(next);
            try { await setDuck({ enabled: next, depth: duckDepth, release: duckRelease }); } catch {}
          }} style={{display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer"}}>
            <div>
              <div style={{fontSize:13,color:"#fff",fontWeight:600}}>Auto-duck for games</div>
              <div style={{fontSize:10,color:"#ffffff66",marginTop:2}}>Lower music when game audio gets loud</div>
            </div>
            <div style={{width:36,height:20,borderRadius:10,background:duckEnabled?"#fa2d48":"rgba(255,255,255,0.15)",position:"relative",flexShrink:0}}>
              <div style={{width:16,height:16,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:duckEnabled?18:2,transition:"left 0.2s"}} />
            </div>
          </FocusHighlight>
          {duckEnabled && (
            <div style={{marginTop:10}}>
              <div style={{fontSize:11,color:"#ffffff99",display:"flex",justifyContent:"space-between"}}><span>Duck strength</span><span>{Math.round((1-duckDepth)*100)}%</span></div>
              <FocusHighlight style={{display:"flex",alignItems:"center",padding:"2px 0"}}>
                <input type="range" min={0} max={1} step={0.01} value={1-duckDepth}
                  onInput={(e:React.FormEvent<HTMLInputElement>)=>{ const depth=Math.max(0,1-parseFloat((e.target as HTMLInputElement).value)); setDuckDepth(depth); }}
                  onChange={(e:React.ChangeEvent<HTMLInputElement>)=>{ const depth=Math.max(0,1-parseFloat(e.target.value)); setDuckDepth(depth); setDuck({ enabled:true, depth, release:duckRelease, attack:duckAttack }).catch(()=>{}); }}
                  style={{flex:1,accentColor:"#fa2d48",height:4}} />
              </FocusHighlight>
              <div style={{fontSize:11,color:"#ffffff99",display:"flex",justifyContent:"space-between",marginTop:6}}><span>Duck speed (dip)</span><span>{duckAttack}ms</span></div>
              <FocusHighlight style={{display:"flex",alignItems:"center",padding:"2px 0"}}>
                <input type="range" min={20} max={400} step={5} value={duckAttack}
                  onInput={(e:React.FormEvent<HTMLInputElement>)=>setDuckAttack(parseFloat((e.target as HTMLInputElement).value))}
                  onChange={(e:React.ChangeEvent<HTMLInputElement>)=>{ const a=parseFloat(e.target.value); setDuckAttack(a); setDuck({ enabled:true, depth:duckDepth, release:duckRelease, attack:a }).catch(()=>{}); }}
                  style={{flex:1,accentColor:"#fa2d48",height:4}} />
              </FocusHighlight>
              <div style={{fontSize:11,color:"#ffffff99",display:"flex",justifyContent:"space-between",marginTop:6}}><span>Recovery speed</span><span>{(duckRelease/1000).toFixed(1)}s</span></div>
              <FocusHighlight style={{display:"flex",alignItems:"center",padding:"2px 0"}}>
                <input type="range" min={300} max={5000} step={100} value={duckRelease}
                  onInput={(e:React.FormEvent<HTMLInputElement>)=>setDuckRelease(parseFloat((e.target as HTMLInputElement).value))}
                  onChange={(e:React.ChangeEvent<HTMLInputElement>)=>{ const r=parseFloat(e.target.value); setDuckRelease(r); setDuck({ enabled:true, depth:duckDepth, release:r, attack:duckAttack }).catch(()=>{}); }}
                  style={{flex:1,accentColor:"#fa2d48",height:4}} />
              </FocusHighlight>
            </div>
          )}
        </div>
        {isSignedIn && (
          <RedActionButton label="Sign out of Apple Music" onActivate={async () => {
             try { await amSignOut(); } catch {}
             window.localStorage.removeItem('apple-music-user-token');
             try { await saveSettings({ developerToken: tokenInput, storefront: sfInput, musicUserToken: "" }); } catch {}
             setMutInput("");
             setStatus("auth");
             setShowSettings(false);
             toaster.toast({ title: "Apple Music", body: "Signed out of Apple Music.", duration: 2500 });
          }} />
        )}
        <div style={{marginTop:12}} />
        <RedActionButton label="Back" onActivate={()=>setShowSettings(false)} />
      </PanelSectionRow>
    </PanelSection>
  );

  if (status === "loading") return (
    <PanelSection>
      <PanelSectionRow>
        <div style={{textAlign:"center",color:"#ffffff88",padding:20, fontSize:13}}>Loading MusicKit Library…</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <FocusHighlight onActivate={() => setShowSettings(true)} style={{width: "100%", borderRadius: 8}}>
          <ButtonItem layout="below">Open Settings</ButtonItem>
        </FocusHighlight>
      </PanelSectionRow>
    </PanelSection>
  );

  if (status === "error") return (
    <PanelSection>
      <PanelSectionRow>
        <div style={{color:"#ff6b6b",fontSize:12,marginBottom:12}}>{errorMsg}</div>
        <FocusHighlight onActivate={()=>boot(sfInput,mutInput)} style={{width:"100%", borderRadius: 8, marginBottom: 8}}>
          <ButtonItem layout="below">Retry</ButtonItem>
        </FocusHighlight>
        <FocusHighlight onActivate={()=>setShowSettings(true)} style={{width:"100%", borderRadius: 8}}>
          <ButtonItem layout="below">Settings</ButtonItem>
        </FocusHighlight>
      </PanelSectionRow>
    </PanelSection>
  );

  if (status === "needsPlayer") return (
    <InstallPlayerScreen onDone={initPlugin} />
  );

  if (status === "auth") return (
    <AuthScreen
      onSettings={()=>setShowSettings(true)}
      onSignedIn={handleSignedIn}
    />
  );

  const nowPlayingSongId = () => {
    const t: any = player.track;
    const id = t?.catalogId || t?.id;
    return id && /^\d+$/.test(String(id)) ? String(id) : null;
  };

  const toggleLove = async () => {
    const id = nowPlayingSongId();
    if (!id || !mk || actionBusy) return;
    setActionBusy("love");
    try {
      if (loved) {
        await mk.api.music(`/v1/me/ratings/songs/${id}`, {}, { fetchOptions: { method: "DELETE" } });
        setLoved(false);
      } else {
        await mk.api.music(`/v1/me/ratings/songs/${id}`, {}, { fetchOptions: {
          method: "PUT",
          body: JSON.stringify({ type: "rating", attributes: { value: 1 } }),
        }});
        setLoved(true);
        toaster.toast({ title: "Apple Music", body: "Added to Favorites ❤️", duration: 2000 });
      }
    } catch (e: any) {
      toaster.toast({ title: "Apple Music", body: "Favorite failed: " + (e?.message || "Unknown"), duration: 3000 });
    }
    setActionBusy(null);
  };

  const addToLibrary = async () => {
    const id = nowPlayingSongId();
    if (!id || !mk || inLib || actionBusy) return;
    setActionBusy("add");
    try {
      await mk.api.music(`/v1/me/library`, { "ids[songs]": id }, { fetchOptions: { method: "POST" } });
      setInLib(true);
      toaster.toast({ title: "Apple Music", body: "Added to Library ✓", duration: 2000 });
    } catch (e: any) {
      toaster.toast({ title: "Apple Music", body: "Add failed: " + (e?.message || "Unknown"), duration: 3000 });
    }
    setActionBusy(null);
  };

  const toggleShuffle = async () => {
    const next = !player.shuffle;
    setPlayer(p => ({ ...p, shuffle: next }));
    try { await setShuffleBackend(next); } catch {}
  };

  const cycleRepeat = async () => {
    // none -> all -> one -> none (MusicKit: 0 none, 1 one, 2 all)
    const next = player.repeat === "none" ? "all" : player.repeat === "all" ? "one" : "none";
    setPlayer(p => ({ ...p, repeat: next }));
    try { await setRepeatBackend(next === "one" ? 1 : next === "all" ? 2 : 0); } catch {}
  };

  // iOS-style "Go to Album" / "Go to Artist" from the now-playing track.
  // Resolves the song's album/artist via the Apple Music API, then navigates
  // the Library tab to the matching detail view.
  const goToNowPlaying = async (kind: "album" | "artist") => {
    if (!mk || navLoading) return;
    const t: any = player.track;
    let songId = t?.catalogId || t?.id;
    if (!songId) {
      toaster.toast({ title: "Apple Music", body: "Nothing is playing", duration: 2500 });
      return;
    }
    setNavLoading(kind);
    try {
      const sf = mk.storefrontId || sfInput || "us";
      // Library song ids (i.xxx) need resolving to their catalog equivalent first
      if (!/^\d+$/.test(String(songId))) {
        const r = await mk.api.music(`/v1/me/library/songs/${songId}/catalog`);
        songId = r?.data?.data?.[0]?.id || songId;
      }
      const r = await mk.api.music(`/v1/catalog/${sf}/songs/${songId}`, { include: "albums,artists" });
      const song = r?.data?.data?.[0];
      const rel = song?.relationships;
      const target = kind === "album" ? rel?.albums?.data?.[0] : rel?.artists?.data?.[0];
      if (!target) throw new Error(`No ${kind} found for this song`);
      setLibNav({
        type: kind,
        id: target.id,
        name: kind === "album" ? (song?.attributes?.albumName || t?.album) : (song?.attributes?.artistName || t?.artist),
      });
      setTab("library");
    } catch (e: any) {
      console.error("[DeckyAM] goToNowPlaying error:", e);
      toaster.toast({ title: "Apple Music", body: `Couldn't open ${kind}: ${e?.message || "Unknown"}`, duration: 3000 });
    }
    setNavLoading(null);
  };

  const { track } = player;
  return (
    <div style={{paddingBottom:8}}>
      <Focusable flow-children="horizontal" style={{display:"flex",borderBottom:"1px solid rgba(255,255,255,0.1)",marginBottom:12, padding: "0 8px"}}>
        {([{key:"player",label:"Now Playing"},{key:"library",label:"Library"},{key:"recent",label:"Recent"}] as const).map(t=>(
          <FocusHighlight key={t.key} onActivate={()=>setTab(t.key as any)} style={{flex:1,background:"none",border:"none",borderBottom:tab===t.key?"2px solid #fa2d48":"2px solid transparent",color:tab===t.key?"#fff":"#ffffff55",padding:"8px 0",cursor:"pointer",fontSize:12,fontWeight:tab===t.key?700:400, textAlign: "center", borderRadius: 4}}>
            {t.label}
          </FocusHighlight>
        ))}
      </Focusable>

      <div style={{padding: "0 16px"}}>
        {tab==="player" && (
          <div style={{padding:"0"}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
            <AlbumArt url={track?.artworkUrl??null} size={64} />
            <div style={{flex:1,overflow:"hidden"}}>
              <div style={{fontSize:14,fontWeight:700,color:"#fff",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{track?.title??"Not Playing"}</div>
              <div style={{fontSize:12,color:"#ffffff88",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",marginTop:2}}>{track?.artist??""}</div>
              <div style={{fontSize:11,color:"#ffffff55",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{track?.album??""}</div>
            </div>
          </div>
          {track && (
            <Focusable flow-children="horizontal" style={{display:"flex",gap:6,marginBottom:10}}>
              <FocusHighlight onActivate={()=>goToNowPlaying("album")} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:5,fontSize:11,fontWeight:600,color:"#ffffffcc",padding:"6px 0",borderRadius:6,border:"1px solid rgba(255,255,255,0.12)",cursor:"pointer"}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>
                {navLoading==="album" ? "Opening…" : "Album"}
              </FocusHighlight>
              <FocusHighlight onActivate={()=>goToNowPlaying("artist")} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:5,fontSize:11,fontWeight:600,color:"#ffffffcc",padding:"6px 0",borderRadius:6,border:"1px solid rgba(255,255,255,0.12)",cursor:"pointer"}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
                {navLoading==="artist" ? "Opening…" : "Artist"}
              </FocusHighlight>
              <FocusHighlight onActivate={toggleLove} style={{width:34,display:"flex",alignItems:"center",justifyContent:"center",padding:"6px 0",borderRadius:6,border:"1px solid rgba(255,255,255,0.12)",cursor:"pointer"}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill={loved ? "#fa2d48" : "none"} stroke={loved ? "#fa2d48" : "#ffffffcc"} strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              </FocusHighlight>
              <FocusHighlight onActivate={addToLibrary} style={{width:34,display:"flex",alignItems:"center",justifyContent:"center",padding:"6px 0",borderRadius:6,border:"1px solid rgba(255,255,255,0.12)",cursor:"pointer"}}>
                {inLib
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="#fa2d48"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                  : <svg width="14" height="14" viewBox="0 0 24 24" fill="#ffffffcc"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>}
              </FocusHighlight>
            </Focusable>
          )}
          <ProgressBar position={player.position} duration={track?.duration??0} onSeek={async (t)=>{ try { await mprisSeek(Math.round(t * 1_000_000)); } catch {} }} />
          <Focusable flow-children="horizontal" style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4,margin:"8px 0"}}>
            <FocusHighlight onActivate={toggleShuffle}
              style={{width:32, height:32, borderRadius:"50%", background:"none", border:"none", cursor:"pointer", color:player.shuffle?"#fa2d48":"#ffffff66", display:"flex", alignItems:"center", justifyContent:"center"}}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
            </FocusHighlight>
            <FocusHighlight onActivate={async ()=>{ try { await mprisPrevious(); } catch {} }}
              style={{width:36, height:36, borderRadius:"50%", background:"none", border:"none", cursor:"pointer", color:"#ffffffcc", display:"flex", alignItems:"center", justifyContent:"center"}}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
            </FocusHighlight>
            <FocusHighlight onActivate={async ()=>{ try { await mprisPlayPause(); } catch {} }}
              style={{width:52,height:52,borderRadius:"50%",background:"#fa2d48",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 12px rgba(250,45,72,0.4)"}}>
              {player.isPlaying
                ?<svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                :<svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>}
            </FocusHighlight>
            <FocusHighlight onActivate={async ()=>{ try { await mprisNext(); } catch {} }}
              style={{width:36, height:36, borderRadius:"50%", background:"none", border:"none", cursor:"pointer", color:"#ffffffcc", display:"flex", alignItems:"center", justifyContent:"center"}}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </FocusHighlight>
            <FocusHighlight onActivate={cycleRepeat}
              style={{width:32, height:32, borderRadius:"50%", background:"none", border:"none", cursor:"pointer", color:player.repeat!=="none"?"#fa2d48":"#ffffff66", display:"flex", alignItems:"center", justifyContent:"center", position:"relative"}}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
              {player.repeat==="one" && <span style={{position:"absolute",top:2,right:2,fontSize:8,fontWeight:700,color:"#fa2d48"}}>1</span>}
            </FocusHighlight>
          </Focusable>
          <Focusable flow-children="horizontal" style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
            <FocusHighlight onActivate={() => applyVolume(player.volume - 0.02)} style={{padding:4, borderRadius:4, flexShrink:0}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff88"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>
            </FocusHighlight>
            <FocusHighlight style={{flex: 1, borderRadius: 4, display: "flex", alignItems: "center", padding: "4px"}}>
              <input type="range" min={0} max={1} step={0.01} value={player.volume}
                onInput={(e:React.FormEvent<HTMLInputElement>)=>applyVolume(parseFloat((e.target as HTMLInputElement).value))}
                onChange={(e:React.ChangeEvent<HTMLInputElement>)=>applyVolume(parseFloat(e.target.value))}
                style={{flex:1,accentColor:"#fa2d48",height:4}} />
            </FocusHighlight>
            <FocusHighlight onActivate={() => applyVolume(player.volume + 0.02)} style={{padding:4, borderRadius:4, flexShrink:0}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff88"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
            </FocusHighlight>
          </Focusable>
          {/* Tracklist */}
          <QueueList />
        </div>
      )}
      {tab==="library"&&mk&&<LibraryPanel mk={mk} onPlay={()=>setTab("player")} nav={libNav} onNavConsumed={()=>setLibNav(null)} />}
      {tab==="recent"&&mk&&<RecentlyPlayedPanel mk={mk} onPlay={()=>setTab("player")} />}
        <div style={{display:"flex", justifyContent:"center", width:"100%", marginTop:16, marginBottom: 8}}>
          <FocusHighlight onActivate={()=>setShowSettings(true)} style={{textAlign:"center",fontSize:11,color:"#ffffff33",cursor:"pointer", padding: "4px 12px", borderRadius: 20, width: "fit-content", border: "1px solid rgba(255,255,255,0.05)"}}>⚙ Settings</FocusHighlight>
        </div>
      </div>
    </div>
  );
};

const Icon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" height="1em" width="1em" fill="currentColor">
    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
  </svg>
);

// Start the global initialization immediately when the module loads via an IIFE
// This prevents Rollup from hoisting 'export default' into 'export { index as default }'
(async () => {
    if ((window as any).GlobalMusicKitPromise) return;

    (window as any).GlobalMusicKitPromise = (async () => {
        try {
            const s = await getSettings();
            const sf = (typeof s.storefront === 'string' && s.storefront) ? s.storefront : DEFAULT_STOREFRONT;
            // Apple's harvested token from the player — nothing shipped.
            const devToken = await getDevToken();
            if (!devToken) throw new Error("Player not ready — no Apple token yet");

            let mut = (typeof s.musicUserToken === 'string') ? s.musicUserToken : "";
            if (!mut) mut = window.localStorage.getItem('apple-music-user-token') || "";

            let mmk = await loadMusicKit(devToken, sf);
            if (mut) {
               await applyMusicUserToken(mmk, mut);
            }
            (window as any).GlobalMusicKit = mmk;
            console.log("[DeckyAM] Global MusicKit initialized successfully natively.");
        } catch (e) {
            console.error("[DeckyAM] Global MusicKit init failed:", e);
            // Clear the guard so a later attempt (e.g. after the player is
            // installed on first run) can re-initialize instead of being stuck.
            try { delete (window as any).GlobalMusicKitPromise; } catch (_) {}
        }
    })();
})();

export default definePlugin((serverApi: any) => ({
  title: <div className={staticClasses.Title}>Apple Music</div>,
  content: <Content />,
  icon: <Icon />,
  onDismount() {},
}));

