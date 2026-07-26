(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const video = $('video');
  const stage = $('stage');
  const drawCanvas = $('drawCanvas');
  const layerCanvas = $('layerCanvas');
  const activeTextCanvas = $('activeTextCanvas');
  const topLayerCanvas = $('topLayerCanvas');
  const drawCtx = drawCanvas.getContext('2d');
  const layerCtx = layerCanvas.getContext('2d');
  const activeTextCtx = activeTextCanvas.getContext('2d');
  const topLayerCtx = topLayerCanvas.getContext('2d');
  const fileInput = $('file');
  const scrub = $('scrub');
  const fpsInput = $('fps');
  const speedInput = $('speed');
  const status = $('status');
  const empty = $('empty');
  const compareRefVideo = $('compareRefVideo');
  const compareOwnVideo = $('compareOwnVideo');
  const analysisVideo = $('analysisVideo');
  const analysisFrameLoader = $('analysisFrameLoader');
  const onionCanvas = $('onionCanvas');
  const guideCanvas = $('guideCanvas');
  const analysisOverlayCanvas = $('analysisOverlayCanvas');
  const onionCtx = onionCanvas.getContext('2d');
  const guideCtx = guideCanvas.getContext('2d');
  const analysisOverlayCtx = analysisOverlayCanvas.getContext('2d');

  const DB_NAME = 'animation-coach-v04';
  const DB_VERSION = 2;
  const LAST_PROJECT_KEY = 'animation-coach-last-project-v04';
  const PROJECT_STORE = 'projects';
  const VIDEO_STORE = 'videos';

  let dbPromise = null;
  let projectId = null;
  let projectCreatedAt = Date.now();
  let projectName = '無題のプロジェクト';
  let videoName = '';
  let objectUrl = null;
  let compareOwnObjectUrl = null;
  let compareOwnVideoName = '';
  let pendingResumeTime = 0;
  let restoring = false;
  let autosaveTimer = null;
  let saveChain = Promise.resolve();
  let projectListTimer = null;

  let A = null;
  let B = null;
  let loopOn = false;
  let tool = 'pen';
  let color = '#ff3b30';
  let brushSize = 6;
  let memos = [];
  let memoDraft = '';
  let memoDraftFrame = 0;
  let compareMode = 'side';
  let compareOpacity = 0.5;
  let compareMarkers = [];
  let compareCurrentTime = 0;
  let comparePlaying = false;
  let compareSyncRefTime = 0;
  let compareSyncOwnTime = 0;
  let compareA = null;
  let compareB = null;
  let compareLoopOn = false;
  let compareAdjustTarget = 'ref';
  let compareTransforms = {
    ref: { scale: 1, x: 0, y: 0, flip: false },
    own: { scale: 1, x: 0, y: 0, flip: false }
  };
  const comparePointers = new Map();
  let compareGesture = null;

  let analysisCurrentTime = 0;
  let analysisPlaying = false;
  let onionEnabled = true;
  let onionPrev = 1;
  let onionNext = 1;
  let onionOpacity = 0.25;
  let analysisMode = 'track';
  let trackers = [];
  let activeTrackerId = '';
  let guideData = null;
  let guideVisible = true;
  let guideTool = 'pen';
  let guideColor = '#ff3b30';
  let guideSize = 5;
  let guideDrawing = false;
  let guidePointerId = null;
  let analysisTrackPointerId = null;
  let guideStartPoint = null;
  let guideLastPoint = null;
  let guideSnapshot = null;
  let keyPoses = [];
  let analysisPhases = { anticipation: null, action: null, follow: null, end: null };
  let analysisRenderToken = 0;
  let onionCaptureChain = Promise.resolve();
  const onionFrameCache = new Map();
  const onionFramePromises = new Map();

  let layers = [];
  let activeLayerId = '';
  let layersGloballyVisible = true;
  let history = {};
  let historyIndex = {};
  let currentLoadedFrame = -1;
  let renderToken = 0;
  const imageCache = new Map();
  let textItems = [];
  let textSize = 36;
  let selectedTextId = null;
  let textDragging = false;
  let pendingTextCreation = false;
  let textDragOffset = null;

  let zoomScale = 1;
  let panX = 0;
  let panY = 0;
  const pointers = new Map();
  let drawing = false;
  let drawingPointerId = null;
  let startPoint = null;
  let lastPoint = null;
  let tempSnapshot = null;
  let pointerMoved = false;
  let gesturing = false;
  let gestureStart = null;

  const uid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  };

  const trackerPalette = ['#ff453a', '#0a84ff', '#30d158', '#ffd60a', '#bf5af2', '#64d2ff', '#ff9f0a'];
  const makeTracker = (name = `軌跡 ${trackers.length + 1}`) => ({
    id: uid(),
    name,
    color: trackerPalette[trackers.length % trackerPalette.length],
    points: {}
  });

  function ensureTrackers() {
    if (!trackers.length) trackers = [makeTracker('軌跡 1')];
    if (!trackers.some(tracker => tracker.id === activeTrackerId)) activeTrackerId = trackers[0].id;
  }

  const activeTracker = () => {
    ensureTrackers();
    return trackers.find(tracker => tracker.id === activeTrackerId) || trackers[0];
  };

  const makeLayer = (name = `レイヤー ${layers.length + 1}`) => ({
    id: uid(),
    name,
    visible: true,
    frames: {}
  });

  function ensureLayers() {
    if (!layers.length) layers = [makeLayer('レイヤー 1')];
    if (!layers.some(layer => layer.id === activeLayerId)) activeLayerId = layers[0].id;
  }

  ensureLayers();
  ensureTrackers();

  const activeLayer = () => {
    ensureLayers();
    return layers.find(layer => layer.id === activeLayerId) || layers[0];
  };

  const fps = () => Math.max(1, Number(fpsInput.value) || 30);
  const frame = () => Math.max(0, Math.round((video.currentTime || 0) * fps()));
  const frameTime = value => Math.max(0, value / fps());
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function fmtTime(seconds) {
    if (!Number.isFinite(seconds)) return '00:00.000';
    const minutes = Math.floor(seconds / 60);
    const wholeSeconds = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds % 1) * 1000);
    return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
  }

  function formatSavedTime(timestamp) {
    return new Intl.DateTimeFormat('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  }

  function setStatus(message) {
    status.textContent = message;
  }

  function setAutosaveStatus(mode, message) {
    const box = $('autosaveStatus');
    box.classList.toggle('saving', mode === 'saving');
    box.classList.toggle('error', mode === 'error');
    box.querySelector('span:last-child').textContent = message;
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB error'));
    });
  }

  function openDatabase() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is not available'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECT_STORE)) {
          db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(VIDEO_STORE)) {
          db.createObjectStore(VIDEO_STORE, { keyPath: 'projectId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('データベースを開けません'));
    });
    return dbPromise;
  }

  async function storeGet(storeName, key) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readonly');
    return requestPromise(tx.objectStore(storeName).get(key));
  }

  async function storeGetAll(storeName) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readonly');
    return requestPromise(tx.objectStore(storeName).getAll());
  }

  async function storePut(storeName, value) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readwrite');
    await requestPromise(tx.objectStore(storeName).put(value));
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('保存できません'));
      tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
    });
  }

  async function storeDelete(storeName, key) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readwrite');
    await requestPromise(tx.objectStore(storeName).delete(key));
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('削除できません'));
      tx.onabort = () => reject(tx.error || new Error('削除が中断されました'));
    });
  }

  function serializeProject() {
    ensureLayers();
    return {
      id: projectId,
      version: '0.7',
      name: projectName,
      createdAt: projectCreatedAt,
      updatedAt: Date.now(),
      videoName,
      currentTime: video.currentTime || 0,
      fps: fps(),
      speed: Number(speedInput.value) || 1,
      A,
      B,
      loopOn,
      layers: layers.map(layer => ({
        id: layer.id,
        name: layer.name,
        visible: layer.visible,
        frames: { ...layer.frames }
      })),
      activeLayerId,
      layersGloballyVisible,
      memos: memos.map(memo => ({ ...memo })),
      memoDraft,
      memoDraftFrame,
      textItems: textItems.map(item => ({ ...item })),
      compare: {
        ownVideoName: compareOwnVideoName,
        mode: compareMode,
        opacity: compareOpacity,
        markers: compareMarkers.map(marker => ({ ...marker })),
        currentTime: compareCurrentTime,
        syncRefTime: compareSyncRefTime,
        syncOwnTime: compareSyncOwnTime,
        A: compareA,
        B: compareB,
        loopOn: compareLoopOn,
        transforms: {
          ref: { ...compareTransforms.ref },
          own: { ...compareTransforms.own }
        }
      },
      analysis: {
        currentTime: analysisCurrentTime,
        onionEnabled,
        onionPrev,
        onionNext,
        onionOpacity,
        mode: analysisMode,
        trackers: trackers.map(tracker => ({
          id: tracker.id,
          name: tracker.name,
          color: tracker.color,
          points: { ...tracker.points }
        })),
        activeTrackerId,
        guideData,
        guideVisible,
        guideTool,
        guideColor,
        guideSize,
        keyPoses: keyPoses.map(pose => ({ ...pose })),
        phases: { ...analysisPhases }
      },
      view: { zoomScale, panX, panY },
      drawing: { tool, color, brushSize, textSize }
    };
  }

  function ensureProjectId() {
    if (!projectId) {
      projectId = uid();
      projectCreatedAt = Date.now();
      localStorage.setItem(LAST_PROJECT_KEY, projectId);
    }
    return projectId;
  }

  function queueAutosave(delay = 650) {
    if (restoring) return;
    ensureProjectId();
    clearTimeout(autosaveTimer);
    setAutosaveStatus('saving', '保存中…');
    autosaveTimer = setTimeout(() => saveProjectNow(), delay);
  }

  function saveProjectNow({ refreshList = false } = {}) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    ensureProjectId();
    const record = serializeProject();
    setAutosaveStatus('saving', '保存中…');
    saveChain = saveChain
      .catch(() => {})
      .then(async () => {
        await storePut(PROJECT_STORE, record);
        localStorage.setItem(LAST_PROJECT_KEY, record.id);
        setAutosaveStatus('saved', `保存済み ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`);
        if (refreshList) await renderProjectList();
        else scheduleProjectListRefresh();
      })
      .catch(error => {
        console.error(error);
        setAutosaveStatus('error', '自動保存に失敗しました。空き容量を確認してください');
      });
    return saveChain;
  }

  function scheduleProjectListRefresh() {
    clearTimeout(projectListTimer);
    projectListTimer = setTimeout(() => renderProjectList(), 900);
  }

  function normalizeLayers(record) {
    if (Array.isArray(record.layers) && record.layers.length) {
      return record.layers.map((layer, index) => ({
        id: typeof layer.id === 'string' && layer.id ? layer.id : uid(),
        name: typeof layer.name === 'string' && layer.name ? layer.name : `レイヤー ${index + 1}`,
        visible: layer.visible !== false,
        frames: layer.frames && typeof layer.frames === 'object' ? { ...layer.frames } : {}
      }));
    }
    if (record.annotations && typeof record.annotations === 'object') {
      return [{
        id: uid(),
        name: 'レイヤー 1',
        visible: true,
        frames: { ...record.annotations }
      }];
    }
    return [makeLayer('レイヤー 1')];
  }

  function normalizeCompareTransform(value) {
    return {
      scale: clamp(Number(value?.scale) || 1, 0.5, 3),
      x: clamp(Number(value?.x) || 0, -100, 100),
      y: clamp(Number(value?.y) || 0, -100, 100),
      flip: Boolean(value?.flip)
    };
  }

  function applyProjectRecord(record) {
    restoring = true;
    projectId = record.id || uid();
    projectCreatedAt = Number(record.createdAt) || Date.now();
    projectName = String(record.name || record.projectName || '無題のプロジェクト');
    videoName = String(record.videoName || '');
    fpsInput.value = String(Number(record.fps) || 30);
    speedInput.value = String(Number(record.speed) || 1);
    video.playbackRate = Number(speedInput.value) || 1;
    A = Number.isFinite(record.A) ? record.A : null;
    B = Number.isFinite(record.B) ? record.B : null;
    loopOn = Boolean(record.loopOn);
    layers = normalizeLayers(record);
    activeLayerId = record.activeLayerId || layers[0].id;
    layersGloballyVisible = record.layersGloballyVisible !== false;
    memos = Array.isArray(record.memos) ? record.memos.map(memo => ({ ...memo })) : [];
    memoDraft = typeof record.memoDraft === 'string' ? record.memoDraft : '';
    memoDraftFrame = Number.isFinite(record.memoDraftFrame) ? record.memoDraftFrame : 0;
    textItems = Array.isArray(record.textItems)
      ? record.textItems
        .filter(item => item && typeof item.text === 'string')
        .map(item => ({
          id: item.id || uid(),
          frame: Math.max(0, Number(item.frame) || 0),
          layerId: item.layerId || record.activeLayerId || layers[0].id,
          text: item.text,
          x: clamp(Number(item.x) || 0, 0, 1),
          y: clamp(Number(item.y) || 0, 0, 1),
          size: clamp(Number(item.size) || 0.08, 0.025, 0.35),
          color: item.color || '#ffffff'
        }))
      : [];
    compareOwnVideoName = String(record.compare?.ownVideoName || '');
    compareMode = ['side', 'overlay', 'difference'].includes(record.compare?.mode)
      ? record.compare.mode
      : 'side';
    compareOpacity = clamp(Number(record.compare?.opacity) || 0.5, 0.1, 0.9);
    compareMarkers = Array.isArray(record.compare?.markers)
      ? record.compare.markers.map(marker => ({
        id: marker.id || uid(),
        frame: Math.max(0, Number(marker.frame) || 0),
        type: ['fix', 'check', 'ok'].includes(marker.type) ? marker.type : 'check',
        note: typeof marker.note === 'string' ? marker.note : ''
      }))
      : [];
    compareCurrentTime = Math.max(0, Number(record.compare?.currentTime) || 0);
    compareSyncRefTime = Math.max(0, Number(record.compare?.syncRefTime) || 0);
    compareSyncOwnTime = Math.max(0, Number(record.compare?.syncOwnTime) || 0);
    compareA = Number.isFinite(record.compare?.A) ? Math.max(0, record.compare.A) : null;
    compareB = Number.isFinite(record.compare?.B) ? Math.max(0, record.compare.B) : null;
    compareLoopOn = Boolean(record.compare?.loopOn);
    compareAdjustTarget = 'ref';
    compareTransforms = {
      ref: normalizeCompareTransform(record.compare?.transforms?.ref),
      own: normalizeCompareTransform(record.compare?.transforms?.own)
    };
    analysisCurrentTime = Math.max(0, Number(record.analysis?.currentTime) || 0);
    onionEnabled = record.analysis?.onionEnabled !== false;
    onionPrev = Number.isFinite(Number(record.analysis?.onionPrev))
      ? clamp(Number(record.analysis.onionPrev), 0, 3)
      : 1;
    onionNext = Number.isFinite(Number(record.analysis?.onionNext))
      ? clamp(Number(record.analysis.onionNext), 0, 3)
      : 1;
    onionOpacity = clamp(Number(record.analysis?.onionOpacity) || 0.25, 0.05, 0.7);
    analysisMode = record.analysis?.mode === 'guide' ? 'guide' : 'track';
    trackers = Array.isArray(record.analysis?.trackers) && record.analysis.trackers.length
      ? record.analysis.trackers.map((tracker, index) => ({
        id: tracker.id || uid(),
        name: String(tracker.name || `軌跡 ${index + 1}`).slice(0, 40),
        color: tracker.color || trackerPalette[index % trackerPalette.length],
        points: tracker.points && typeof tracker.points === 'object' ? { ...tracker.points } : {}
      }))
      : [makeTracker('軌跡 1')];
    activeTrackerId = record.analysis?.activeTrackerId || trackers[0].id;
    guideData = typeof record.analysis?.guideData === 'string' ? record.analysis.guideData : null;
    guideVisible = record.analysis?.guideVisible !== false;
    guideTool = record.analysis?.guideTool === 'line' ? 'line' : 'pen';
    guideColor = record.analysis?.guideColor || '#ff3b30';
    guideSize = clamp(Number(record.analysis?.guideSize) || 5, 2, 30);
    keyPoses = Array.isArray(record.analysis?.keyPoses)
      ? record.analysis.keyPoses
        .filter(pose => pose && typeof pose.thumbnail === 'string')
        .map(pose => ({
          id: pose.id || uid(),
          frame: Math.max(0, Number(pose.frame) || 0),
          note: typeof pose.note === 'string' ? pose.note : '',
          thumbnail: pose.thumbnail
        }))
      : [];
    analysisPhases = {
      anticipation: Number.isFinite(record.analysis?.phases?.anticipation) ? Math.max(0, record.analysis.phases.anticipation) : null,
      action: Number.isFinite(record.analysis?.phases?.action) ? Math.max(0, record.analysis.phases.action) : null,
      follow: Number.isFinite(record.analysis?.phases?.follow) ? Math.max(0, record.analysis.phases.follow) : null,
      end: Number.isFinite(record.analysis?.phases?.end) ? Math.max(0, record.analysis.phases.end) : null
    };
    zoomScale = clamp(Number(record.view?.zoomScale) || 1, 1, 4);
    panX = Number(record.view?.panX) || 0;
    panY = Number(record.view?.panY) || 0;
    tool = record.drawing?.tool || 'pen';
    color = record.drawing?.color || '#ff3b30';
    brushSize = clamp(Number(record.drawing?.brushSize) || 6, 2, 30);
    textSize = clamp(Number(record.drawing?.textSize) || 36, 16, 96);
    selectedTextId = null;
    pendingResumeTime = Math.max(0, Number(record.currentTime) || 0);
    history = {};
    historyIndex = {};
    currentLoadedFrame = -1;
    ensureLayers();
    ensureTrackers();

    $('projectNameInput').value = projectName;
    $('brushSize').value = String(brushSize);
    $('brushValue').textContent = String(brushSize);
    $('textSize').value = String(textSize);
    $('textSizeValue').textContent = String(textSize);
    document.querySelectorAll('.tool').forEach(button => {
      button.classList.toggle('active', button.dataset.tool === tool);
    });
    $('textControls').classList.toggle('hidden', tool !== 'text');
    document.querySelectorAll('.swatch').forEach(button => {
      button.classList.toggle('active', button.dataset.color === color);
    });
    $('loop').textContent = `ABループ ${loopOn ? 'ON' : 'OFF'}`;
    $('loop').classList.toggle('primary', loopOn);
    $('memoInput').value = memoDraft;
    renderMemos();
    renderLayerList();
    renderCompareUi();
    renderAnalysisUi();
    applyViewTransform();
    applyLayerVisibility();
    updateHud(true);
    restoring = false;
  }

  function revokeVideoUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  function revokeCompareOwnUrl() {
    if (compareOwnObjectUrl) {
      URL.revokeObjectURL(compareOwnObjectUrl);
      compareOwnObjectUrl = null;
    }
  }

  function clearVideoSource() {
    video.pause();
    compareRefVideo.pause();
    analysisVideo.pause();
    analysisPlaying = false;
    analysisCurrentTime = 0;
    onionFrameCache.clear();
    analysisRenderToken += 1;
    revokeVideoUrl();
    video.removeAttribute('src');
    compareRefVideo.removeAttribute('src');
    analysisVideo.removeAttribute('src');
    analysisFrameLoader.removeAttribute('src');
    video.load();
    compareRefVideo.load();
    analysisVideo.load();
    analysisFrameLoader.load();
    empty.classList.remove('hidden');
    $('compareRefEmpty').classList.remove('hidden');
    $('analysisEmpty').classList.remove('hidden');
    scrub.value = '0';
    currentLoadedFrame = -1;
    renderCurrentFrame(0);
  }

  function loadVideoBlob(blob, name = '') {
    return new Promise((resolve, reject) => {
      video.pause();
      analysisVideo.pause();
      analysisPlaying = false;
      analysisRenderToken += 1;
      onionFrameCache.clear();
      revokeVideoUrl();
      objectUrl = URL.createObjectURL(blob);
      video.src = objectUrl;
      compareRefVideo.src = objectUrl;
      analysisVideo.src = objectUrl;
      analysisFrameLoader.src = objectUrl;
      videoName = name || videoName;
      empty.classList.add('hidden');
      $('compareRefEmpty').classList.add('hidden');
      $('analysisEmpty').classList.add('hidden');
      const onLoaded = () => {
        cleanup();
        const end = Math.max(0, (video.duration || 0) - 0.001);
        video.currentTime = clamp(pendingResumeTime, 0, end);
        pendingResumeTime = 0;
        resizeCanvases();
        updateHud(true);
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('動画を読み込めません'));
      };
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);
      video.load();
      compareRefVideo.load();
      analysisVideo.load();
      analysisFrameLoader.load();
    });
  }

  function clearCompareOwnSource() {
    compareOwnVideo.pause();
    revokeCompareOwnUrl();
    compareOwnVideo.removeAttribute('src');
    compareOwnVideo.load();
    compareOwnVideoName = '';
    $('compareOwnEmpty').classList.remove('hidden');
  }

  function loadCompareOwnBlob(blob, name = '') {
    return new Promise((resolve, reject) => {
      compareOwnVideo.pause();
      revokeCompareOwnUrl();
      compareOwnObjectUrl = URL.createObjectURL(blob);
      compareOwnVideo.src = compareOwnObjectUrl;
      compareOwnVideoName = name || compareOwnVideoName;
      $('compareOwnEmpty').classList.add('hidden');
      const onLoaded = () => {
        cleanup();
        setCompareTime(compareCurrentTime, false);
        renderCompareUi();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('比較動画を読み込めません'));
      };
      const cleanup = () => {
        compareOwnVideo.removeEventListener('loadedmetadata', onLoaded);
        compareOwnVideo.removeEventListener('error', onError);
      };
      compareOwnVideo.addEventListener('loadedmetadata', onLoaded);
      compareOwnVideo.addEventListener('error', onError);
      compareOwnVideo.load();
    });
  }

  async function restoreProject(record) {
    applyProjectRecord(record);
    localStorage.setItem(LAST_PROJECT_KEY, projectId);
    const videoRecord = await storeGet(VIDEO_STORE, projectId).catch(() => null);
    if (videoRecord?.blob) {
      try {
        await loadVideoBlob(videoRecord.blob, videoRecord.name || record.videoName);
      } catch (error) {
        console.error(error);
        clearVideoSource();
        setStatus('保存動画を開けませんでした。動画を選び直してください');
      }
    } else {
      clearVideoSource();
    }
    if (videoRecord?.compareBlob) {
      try {
        await loadCompareOwnBlob(videoRecord.compareBlob, videoRecord.compareName || record.compare?.ownVideoName);
      } catch (error) {
        console.error(error);
        clearCompareOwnSource();
      }
    } else {
      clearCompareOwnSource();
    }
    setCompareTime(compareCurrentTime, false);
    setAnalysisTime(analysisCurrentTime, false);
    renderLayerList();
    renderMemos();
    renderCurrentFrame(frame());
    renderAnalysisUi();
  }

  async function createNewProject({ saveCurrent = true } = {}) {
    if (saveCurrent) await saveProjectNow();
    restoring = true;
    projectId = uid();
    projectCreatedAt = Date.now();
    projectName = '無題のプロジェクト';
    videoName = '';
    compareOwnVideoName = '';
    A = null;
    B = null;
    loopOn = false;
    layers = [makeLayer('レイヤー 1')];
    activeLayerId = layers[0].id;
    layersGloballyVisible = true;
    memos = [];
    textItems = [];
    memoDraft = '';
    memoDraftFrame = 0;
    history = {};
    historyIndex = {};
    zoomScale = 1;
    panX = 0;
    panY = 0;
    compareMode = 'side';
    compareOpacity = 0.5;
    compareMarkers = [];
    compareCurrentTime = 0;
    compareSyncRefTime = 0;
    compareSyncOwnTime = 0;
    compareA = null;
    compareB = null;
    compareLoopOn = false;
    compareAdjustTarget = 'ref';
    compareTransforms = {
      ref: { scale: 1, x: 0, y: 0, flip: false },
      own: { scale: 1, x: 0, y: 0, flip: false }
    };
    analysisCurrentTime = 0;
    analysisPlaying = false;
    onionEnabled = true;
    onionPrev = 1;
    onionNext = 1;
    onionOpacity = 0.25;
    analysisMode = 'track';
    trackers = [];
    trackers = [makeTracker('軌跡 1')];
    activeTrackerId = trackers[0].id;
    guideData = null;
    guideVisible = true;
    guideTool = 'pen';
    guideColor = '#ff3b30';
    guideSize = 5;
    keyPoses = [];
    analysisPhases = { anticipation: null, action: null, follow: null, end: null };
    onionFrameCache.clear();
    pendingResumeTime = 0;
    fpsInput.value = '30';
    speedInput.value = '1';
    video.playbackRate = 1;
    $('projectNameInput').value = projectName;
    $('memoInput').value = '';
    $('loop').textContent = 'ABループ OFF';
    $('loop').classList.remove('primary');
    clearVideoSource();
    clearCompareOwnSource();
    renderLayerList();
    renderMemos();
    renderCompareUi();
    renderAnalysisUi();
    applyViewTransform();
    applyLayerVisibility();
    localStorage.setItem(LAST_PROJECT_KEY, projectId);
    restoring = false;
    await saveProjectNow({ refreshList: true });
    setStatus('新しいプロジェクトを作りました');
  }

  async function renderProjectList() {
    const list = $('projectList');
    try {
      const projects = (await storeGetAll(PROJECT_STORE))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      list.replaceChildren();
      if (!projects.length) {
        const emptyItem = document.createElement('div');
        emptyItem.className = 'project-meta';
        emptyItem.textContent = '保存済みプロジェクトはまだありません';
        list.append(emptyItem);
        return;
      }
      projects.forEach(project => {
        const item = document.createElement('div');
        item.className = `project-item${project.id === projectId ? ' current' : ''}`;
        item.dataset.id = project.id;

        const info = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'project-name';
        name.textContent = project.name || '無題のプロジェクト';
        const meta = document.createElement('div');
        meta.className = 'project-meta';
        const videoLabel = project.videoName ? `・${project.videoName}` : '・動画なし';
        meta.textContent = `${formatSavedTime(project.updatedAt || Date.now())}${videoLabel}`;
        info.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'project-actions';
        const open = document.createElement('button');
        open.className = 'layer-mini';
        open.dataset.action = 'open';
        open.textContent = project.id === projectId ? '表示中' : '開く';
        open.disabled = project.id === projectId;
        const remove = document.createElement('button');
        remove.className = 'layer-mini delete';
        remove.dataset.action = 'delete';
        remove.textContent = '削除';
        actions.append(open, remove);
        item.append(info, actions);
        list.append(item);
      });
    } catch (error) {
      console.error(error);
      list.textContent = 'プロジェクト一覧を読み込めませんでした';
    }
  }

  async function initPersistence() {
    try {
      await openDatabase();
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      let record = null;
      const lastId = localStorage.getItem(LAST_PROJECT_KEY);
      if (lastId) record = await storeGet(PROJECT_STORE, lastId);
      if (!record) {
        const projects = await storeGetAll(PROJECT_STORE);
        record = projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
      }
      if (record) {
        await restoreProject(record);
        setAutosaveStatus('saved', '前回の続きから再開しました');
      } else {
        restoring = false;
        ensureProjectId();
        await saveProjectNow({ refreshList: true });
      }
      await renderProjectList();
    } catch (error) {
      console.error(error);
      setAutosaveStatus('error', 'このブラウザでは自動保存を使えません');
      applyProjectRecord(serializeProject());
    }
  }

  function sizeCanvas(canvas, context) {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function resizeCanvases() {
    sizeCanvas(layerCanvas, layerCtx);
    sizeCanvas(drawCanvas, drawCtx);
    sizeCanvas(activeTextCanvas, activeTextCtx);
    sizeCanvas(topLayerCanvas, topLayerCtx);
    clampPan();
    applyViewTransform();
    currentLoadedFrame = -1;
    renderCurrentFrame(frame());
  }

  function clearContext(context, canvas) {
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  }

  function getImage(data) {
    if (!data) return Promise.resolve(null);
    if (imageCache.has(data)) return imageCache.get(data);
    const promise = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = data;
    }).catch(() => null);
    imageCache.set(data, promise);
    if (imageCache.size > 120) {
      const first = imageCache.keys().next().value;
      imageCache.delete(first);
    }
    return promise;
  }

  function layerTexts(layerId, targetFrame) {
    return textItems.filter(item => item.layerId === layerId && item.frame === targetFrame);
  }

  function drawTextItem(context, item, width, height, showSelection = false) {
    const fontSize = clamp(item.size * height, 10, height * 0.4);
    const x = item.x * width;
    const y = item.y * height;
    context.save();
    context.font = `800 ${fontSize}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
    context.textBaseline = 'top';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(2, fontSize * 0.09);
    context.strokeStyle = '#000c';
    context.fillStyle = item.color || '#fff';
    context.strokeText(item.text, x, y);
    context.fillText(item.text, x, y);
    if (showSelection) {
      const metrics = context.measureText(item.text);
      context.setLineDash([5, 4]);
      context.lineWidth = 2;
      context.strokeStyle = '#ff4fa3';
      context.strokeRect(x - 5, y - 4, metrics.width + 10, fontSize * 1.2 + 8);
    }
    context.restore();
  }

  function drawLayerTexts(context, layerId, targetFrame, width, height, selectable = false) {
    for (const item of layerTexts(layerId, targetFrame)) {
      drawTextItem(context, item, width, height, selectable && item.id === selectedTextId && tool === 'text');
    }
  }

  async function renderCurrentFrame(targetFrame = frame()) {
    const token = ++renderToken;
    currentLoadedFrame = targetFrame;
    clearContext(drawCtx, drawCanvas);
    clearContext(layerCtx, layerCanvas);
    clearContext(activeTextCtx, activeTextCanvas);
    clearContext(topLayerCtx, topLayerCanvas);
    ensureLayers();

    const active = activeLayer();
    const activeData = active.frames[targetFrame];
    if (activeData) {
      const image = await getImage(activeData);
      if (token !== renderToken) return;
      if (image) drawCtx.drawImage(image, 0, 0, drawCanvas.clientWidth, drawCanvas.clientHeight);
    }
    drawLayerTexts(
      activeTextCtx,
      active.id,
      targetFrame,
      activeTextCanvas.clientWidth,
      activeTextCanvas.clientHeight,
      true
    );

    const activeIndex = layers.findIndex(layer => layer.id === active.id);
    const layersBelow = layers
      .slice(activeIndex + 1)
      .reverse()
      .filter(layer => layer.visible && (layer.frames[targetFrame] || layerTexts(layer.id, targetFrame).length));
    for (const layer of layersBelow) {
      if (layer.frames[targetFrame]) {
        const image = await getImage(layer.frames[targetFrame]);
        if (token !== renderToken) return;
        if (image) layerCtx.drawImage(image, 0, 0, layerCanvas.clientWidth, layerCanvas.clientHeight);
      }
      drawLayerTexts(layerCtx, layer.id, targetFrame, layerCanvas.clientWidth, layerCanvas.clientHeight);
    }
    const layersAbove = layers
      .slice(0, activeIndex)
      .reverse()
      .filter(layer => layer.visible && (layer.frames[targetFrame] || layerTexts(layer.id, targetFrame).length));
    for (const layer of layersAbove) {
      if (layer.frames[targetFrame]) {
        const image = await getImage(layer.frames[targetFrame]);
        if (token !== renderToken) return;
        if (image) topLayerCtx.drawImage(image, 0, 0, topLayerCanvas.clientWidth, topLayerCanvas.clientHeight);
      }
      drawLayerTexts(topLayerCtx, layer.id, targetFrame, topLayerCanvas.clientWidth, topLayerCanvas.clientHeight);
    }
    applyLayerVisibility();
  }

  function canvasData() {
    return drawCanvas.toDataURL('image/png');
  }

  function historyKey(targetFrame = frame(), layerId = activeLayerId) {
    return `${layerId}:${targetFrame}`;
  }

  function setActiveFrameData(data, pushHistory = true) {
    const targetFrame = frame();
    const layer = activeLayer();
    const oldData = layer.frames[targetFrame] || null;
    if (data) layer.frames[targetFrame] = data;
    else delete layer.frames[targetFrame];
    imageCache.delete(oldData);
    imageCache.delete(data);

    if (pushHistory) {
      const key = historyKey(targetFrame, layer.id);
      if (!history[key]) {
        history[key] = [oldData];
        historyIndex[key] = 0;
      }
      const index = historyIndex[key] ?? history[key].length - 1;
      history[key] = history[key].slice(0, index + 1);
      if (history[key][history[key].length - 1] !== data) history[key].push(data);
      historyIndex[key] = history[key].length - 1;
    }
    queueAutosave();
  }

  function commitDrawing() {
    setActiveFrameData(canvasData(), true);
    renderCurrentFrame(frame());
    setStatus(`${frame()}F・${activeLayer().name} に保存しました`);
  }

  function applyLayerVisibility() {
    const active = activeLayer();
    const visible = layersGloballyVisible;
    layerCanvas.style.opacity = visible ? '1' : '0';
    activeTextCanvas.style.opacity = visible && active.visible ? '1' : '0';
    topLayerCanvas.style.opacity = visible ? '1' : '0';
    drawCanvas.style.opacity = visible && active.visible ? '1' : '0';
    const toggle = $('toggleAllLayers');
    toggle.textContent = visible ? '👁 書込 ON' : '🙈 書込 OFF';
    toggle.classList.toggle('off', !visible);
    toggle.setAttribute('aria-pressed', String(visible));
  }

  function renderLayerList() {
    ensureLayers();
    const list = $('layerList');
    list.replaceChildren();
    layers.forEach((layer, index) => {
      const item = document.createElement('div');
      item.className = `layer-item${layer.id === activeLayerId ? ' active' : ''}`;
      item.dataset.id = layer.id;

      const eye = document.createElement('button');
      eye.className = `layer-eye${layer.visible ? '' : ' off'}`;
      eye.dataset.action = 'visibility';
      eye.textContent = layer.visible ? '👁' : '—';
      eye.setAttribute('aria-label', `${layer.name}を${layer.visible ? '非表示' : '表示'}`);

      const name = document.createElement('button');
      name.className = 'layer-name';
      name.dataset.action = 'select';
      name.textContent = layer.name;

      const actions = document.createElement('div');
      actions.className = 'layer-actions';
      [
        ['up', '↑', '前面へ', index === 0],
        ['down', '↓', '背面へ', index === layers.length - 1],
        ['rename', '✎', '名前変更', false],
        ['delete', '×', '削除', layers.length === 1]
      ].forEach(([action, label, aria, disabled]) => {
        const button = document.createElement('button');
        button.className = `layer-mini${action === 'delete' ? ' delete' : ''}`;
        button.dataset.action = action;
        button.textContent = label;
        button.setAttribute('aria-label', aria);
        button.disabled = disabled;
        actions.append(button);
      });
      item.append(eye, name, actions);
      list.append(item);
    });
    applyLayerVisibility();
  }

  function selectLayer(id) {
    if (!layers.some(layer => layer.id === id) || activeLayerId === id) return;
    activeLayerId = id;
    selectedTextId = null;
    currentLoadedFrame = -1;
    renderLayerList();
    renderCurrentFrame(frame());
    queueAutosave();
  }

  function addLayer() {
    const layer = makeLayer(`レイヤー ${layers.length + 1}`);
    layers.unshift(layer);
    activeLayerId = layer.id;
    selectedTextId = null;
    renderLayerList();
    renderCurrentFrame(frame());
    queueAutosave();
    setStatus(`${layer.name}を追加しました`);
  }

  function pointFromEvent(event) {
    const rect = drawCanvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (drawCanvas.clientWidth / rect.width),
      y: (event.clientY - rect.top) * (drawCanvas.clientHeight / rect.height)
    };
  }

  function selectedText() {
    return textItems.find(item => item.id === selectedTextId) || null;
  }

  function findActiveTextAt(point) {
    const items = [...layerTexts(activeLayerId, frame())].reverse();
    for (const item of items) {
      const fontSize = item.size * activeTextCanvas.clientHeight;
      activeTextCtx.save();
      activeTextCtx.font = `800 ${fontSize}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      const width = activeTextCtx.measureText(item.text).width;
      activeTextCtx.restore();
      const x = item.x * activeTextCanvas.clientWidth;
      const y = item.y * activeTextCanvas.clientHeight;
      if (point.x >= x - 8 && point.x <= x + width + 8
        && point.y >= y - 8 && point.y <= y + fontSize * 1.25 + 8) {
        return item;
      }
    }
    return null;
  }

  function createTextAt(point) {
    const value = prompt('表示する文字を入力')?.trim();
    if (!value) return;
    const item = {
      id: uid(),
      frame: frame(),
      layerId: activeLayerId,
      text: value.slice(0, 120),
      x: clamp(point.x / drawCanvas.clientWidth, 0, 0.94),
      y: clamp(point.y / drawCanvas.clientHeight, 0, 0.9),
      size: clamp(textSize / drawCanvas.clientHeight, 0.025, 0.35),
      color
    };
    textItems.push(item);
    selectedTextId = item.id;
    renderCurrentFrame(frame());
    queueAutosave();
    setStatus('文字を追加しました。ドラッグで移動できます');
  }

  function beginTextInteraction(event) {
    const point = pointFromEvent(event);
    drawing = true;
    drawingPointerId = event.pointerId;
    startPoint = point;
    lastPoint = point;
    pointerMoved = false;
    const hit = findActiveTextAt(point);
    selectedTextId = hit?.id || null;
    if (hit) {
      textSize = clamp(Math.round(hit.size * drawCanvas.clientHeight), 16, 96);
      $('textSize').value = String(textSize);
      $('textSizeValue').textContent = String(textSize);
    }
    textDragging = Boolean(hit);
    pendingTextCreation = !hit;
    textDragOffset = hit ? {
      x: point.x - hit.x * drawCanvas.clientWidth,
      y: point.y - hit.y * drawCanvas.clientHeight
    } : null;
    renderCurrentFrame(frame());
  }

  function continueTextInteraction(event) {
    if (!drawing || event.pointerId !== drawingPointerId) return;
    const point = pointFromEvent(event);
    pointerMoved = pointerMoved || Math.hypot(point.x - startPoint.x, point.y - startPoint.y) > 2;
    const item = selectedText();
    if (textDragging && item) {
      item.x = clamp((point.x - textDragOffset.x) / drawCanvas.clientWidth, 0, 0.95);
      item.y = clamp((point.y - textDragOffset.y) / drawCanvas.clientHeight, 0, 0.92);
      renderCurrentFrame(frame());
    }
    lastPoint = point;
  }

  function finishTextInteraction(event) {
    if (!drawing || event.pointerId !== drawingPointerId) return;
    const shouldCreate = pendingTextCreation && !pointerMoved;
    const creationPoint = startPoint;
    drawing = false;
    drawingPointerId = null;
    textDragging = false;
    pendingTextCreation = false;
    textDragOffset = null;
    startPoint = null;
    lastPoint = null;
    if (shouldCreate) createTextAt(creationPoint);
    else {
      renderCurrentFrame(frame());
      queueAutosave();
    }
  }

  function prepareStrokeContext() {
    drawCtx.lineWidth = brushSize;
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.strokeStyle = color;
    drawCtx.fillStyle = color;
    drawCtx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
  }

  function drawDot(point) {
    prepareStrokeContext();
    drawCtx.beginPath();
    drawCtx.arc(point.x, point.y, Math.max(1, brushSize / 2), 0, Math.PI * 2);
    drawCtx.fill();
    drawCtx.globalCompositeOperation = 'source-over';
  }

  function drawShape(from, to) {
    prepareStrokeContext();
    drawCtx.beginPath();
    if (tool === 'line') {
      drawCtx.moveTo(from.x, from.y);
      drawCtx.lineTo(to.x, to.y);
    } else if (tool === 'circle') {
      const cx = (from.x + to.x) / 2;
      const cy = (from.y + to.y) / 2;
      const rx = Math.abs(to.x - from.x) / 2;
      const ry = Math.abs(to.y - from.y) / 2;
      if (drawCtx.ellipse) drawCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      else drawCtx.arc(cx, cy, Math.max(rx, ry), 0, Math.PI * 2);
    } else if (tool === 'arrow') {
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const head = Math.max(12, brushSize * 2.7);
      drawCtx.moveTo(from.x, from.y);
      drawCtx.lineTo(to.x, to.y);
      drawCtx.moveTo(to.x, to.y);
      drawCtx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
      drawCtx.moveTo(to.x, to.y);
      drawCtx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
    }
    drawCtx.stroke();
    drawCtx.globalCompositeOperation = 'source-over';
  }

  function beginDrawing(event) {
    video.pause();
    const active = activeLayer();
    if (!active.visible) {
      active.visible = true;
      renderLayerList();
    }
    if (!layersGloballyVisible) {
      layersGloballyVisible = true;
      applyLayerVisibility();
    }
    if (tool === 'text') {
      beginTextInteraction(event);
      return;
    }
    drawing = true;
    drawingPointerId = event.pointerId;
    pointerMoved = false;
    startPoint = pointFromEvent(event);
    lastPoint = startPoint;
    tempSnapshot = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
    prepareStrokeContext();
    if (tool === 'pen' || tool === 'eraser') {
      drawCtx.beginPath();
      drawCtx.moveTo(startPoint.x, startPoint.y);
    }
  }

  function restoreTempSnapshot() {
    if (tempSnapshot) drawCtx.putImageData(tempSnapshot, 0, 0);
  }

  function continueDrawing(event) {
    if (tool === 'text') {
      continueTextInteraction(event);
      return;
    }
    if (!drawing || event.pointerId !== drawingPointerId) return;
    const point = pointFromEvent(event);
    pointerMoved = pointerMoved || Math.hypot(point.x - startPoint.x, point.y - startPoint.y) > 1.5;
    if (tool === 'pen' || tool === 'eraser') {
      prepareStrokeContext();
      drawCtx.beginPath();
      drawCtx.moveTo(lastPoint.x, lastPoint.y);
      drawCtx.lineTo(point.x, point.y);
      drawCtx.stroke();
      drawCtx.globalCompositeOperation = 'source-over';
    } else {
      restoreTempSnapshot();
      drawShape(startPoint, point);
    }
    lastPoint = point;
  }

  function finishDrawing(event) {
    if (tool === 'text') {
      finishTextInteraction(event);
      return;
    }
    if (!drawing || event.pointerId !== drawingPointerId) return;
    if (!pointerMoved && (tool === 'pen' || tool === 'eraser')) drawDot(startPoint);
    drawing = false;
    drawingPointerId = null;
    startPoint = null;
    lastPoint = null;
    tempSnapshot = null;
    commitDrawing();
  }

  function cancelDrawingForGesture() {
    if (!drawing) return;
    if (tool !== 'text') restoreTempSnapshot();
    drawing = false;
    drawingPointerId = null;
    tempSnapshot = null;
    textDragging = false;
    pendingTextCreation = false;
    textDragOffset = null;
  }

  function pointerPair() {
    return [...pointers.values()].slice(0, 2);
  }

  function pairMetrics(pair) {
    const [a, b] = pair;
    return {
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      centerX: (a.x + b.x) / 2,
      centerY: (a.y + b.y) / 2
    };
  }

  function startGesture() {
    cancelDrawingForGesture();
    gesturing = true;
    const metrics = pairMetrics(pointerPair());
    gestureStart = {
      ...metrics,
      scale: zoomScale,
      panX,
      panY
    };
  }

  function updateGesture() {
    if (!gesturing || pointers.size < 2 || !gestureStart) return;
    const metrics = pairMetrics(pointerPair());
    const nextScale = clamp(gestureStart.scale * (metrics.distance / gestureStart.distance), 1, 4);
    const stageRect = stage.getBoundingClientRect();
    const originX = gestureStart.centerX - (stageRect.left + stageRect.width / 2) - gestureStart.panX;
    const originY = gestureStart.centerY - (stageRect.top + stageRect.height / 2) - gestureStart.panY;
    const ratio = nextScale / gestureStart.scale;
    panX = gestureStart.panX
      + (metrics.centerX - gestureStart.centerX)
      - originX * (ratio - 1);
    panY = gestureStart.panY
      + (metrics.centerY - gestureStart.centerY)
      - originY * (ratio - 1);
    zoomScale = nextScale;
    clampPan();
    applyViewTransform();
  }

  function clampPan() {
    const maxX = Math.max(0, stage.clientWidth * (zoomScale - 1) / 2);
    const maxY = Math.max(0, stage.clientHeight * (zoomScale - 1) / 2);
    panX = clamp(panX, -maxX, maxX);
    panY = clamp(panY, -maxY, maxY);
    if (zoomScale <= 1.001) {
      zoomScale = 1;
      panX = 0;
      panY = 0;
    }
  }

  function applyViewTransform() {
    clampPan();
    const transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoomScale})`;
    [video, layerCanvas, drawCanvas, activeTextCanvas, topLayerCanvas].forEach(element => {
      element.style.transform = transform;
    });
    $('zoomLabel').textContent = `${Math.round(zoomScale * 100)}%`;
  }

  function resetView() {
    zoomScale = 1;
    panX = 0;
    panY = 0;
    applyViewTransform();
    queueAutosave();
    setStatus('表示を元の大きさに戻しました');
  }

  function updateHud(forceRender = false) {
    const currentFrame = frame();
    $('frameHud').textContent = `F ${currentFrame}`;
    $('timeHud').textContent = fmtTime(video.currentTime || 0);
    $('gotoFrame').value = String(currentFrame);
    $('memoFrameLabel').textContent = `${currentFrame}F`;
    if (selectedText()?.frame !== currentFrame) selectedTextId = null;
    if (video.duration) scrub.value = String(Math.round((video.currentTime / video.duration) * 1000));
    if ((forceRender || currentFrame !== currentLoadedFrame) && !drawing && !gesturing) {
      renderCurrentFrame(currentFrame);
    }
  }

  function seekToTime(time) {
    if (!video.duration) return;
    video.pause();
    video.currentTime = clamp(time, 0, Math.max(0, video.duration - 0.001));
    updateHud(true);
    queueAutosave(900);
  }

  function seekToFrame(targetFrame) {
    seekToTime(frameTime(Math.max(0, Number(targetFrame) || 0)));
  }

  function stepFrames(amount) {
    seekToFrame(frame() + amount);
  }

  function animationLoop() {
    if (loopOn && A !== null && B !== null && B > A && video.currentTime >= B) {
      video.currentTime = A;
    }
    updateHud();
    requestAnimationFrame(animationLoop);
  }

  function compareBounds() {
    const hasRef = Boolean(compareRefVideo.src && Number.isFinite(compareRefVideo.duration));
    const hasOwn = Boolean(compareOwnVideo.src && Number.isFinite(compareOwnVideo.duration));
    if (hasRef && hasOwn) {
      const min = Math.max(0, compareSyncRefTime - compareSyncOwnTime);
      const max = Math.min(
        compareRefVideo.duration,
        compareSyncRefTime + compareOwnVideo.duration - compareSyncOwnTime
      );
      if (max > min) return { min, max };
    }
    if (hasRef) return { min: 0, max: compareRefVideo.duration };
    if (hasOwn) return { min: 0, max: compareOwnVideo.duration };
    return { min: 0, max: 0 };
  }

  function mappedCompareTimes(timelineTime) {
    const hasRef = Boolean(compareRefVideo.src && compareRefVideo.readyState >= 1);
    const hasOwn = Boolean(compareOwnVideo.src && compareOwnVideo.readyState >= 1);
    if (hasRef && hasOwn) {
      return {
        ref: timelineTime,
        own: timelineTime - compareSyncRefTime + compareSyncOwnTime
      };
    }
    return { ref: timelineTime, own: timelineTime };
  }

  function compareMasterVideo() {
    if (compareRefVideo.src && compareRefVideo.readyState >= 1) return compareRefVideo;
    if (compareOwnVideo.src && compareOwnVideo.readyState >= 1) return compareOwnVideo;
    return null;
  }

  function setCompareTime(time, autosave = true) {
    const bounds = compareBounds();
    const max = bounds.max ? Math.max(bounds.min, bounds.max - 0.001) : Math.max(0, Number(time) || 0);
    compareCurrentTime = clamp(Number(time) || 0, bounds.min, max);
    const mapped = mappedCompareTimes(compareCurrentTime);
    if (compareRefVideo.src && compareRefVideo.readyState >= 1) {
      compareRefVideo.currentTime = clamp(mapped.ref, 0, Math.max(0, compareRefVideo.duration - 0.001));
    }
    if (compareOwnVideo.src && compareOwnVideo.readyState >= 1) {
      compareOwnVideo.currentTime = clamp(mapped.own, 0, Math.max(0, compareOwnVideo.duration - 0.001));
    }
    updateCompareHud();
    if (autosave) queueAutosave(900);
  }

  function updateCompareHud() {
    const mapped = mappedCompareTimes(compareCurrentTime);
    const refFrame = Math.max(0, Math.round(mapped.ref * fps()));
    const ownFrame = Math.max(0, Math.round(mapped.own * fps()));
    $('compareFrameHud').textContent = `参考 ${refFrame}F / 自作 ${ownFrame}F`;
    $('compareTimeHud').textContent = fmtTime(compareCurrentTime);
    const bounds = compareBounds();
    const duration = bounds.max - bounds.min;
    $('compareScrub').value = duration > 0
      ? String(Math.round(((compareCurrentTime - bounds.min) / duration) * 1000))
      : '0';
  }

  function pauseComparison(autosave = true) {
    comparePlaying = false;
    compareRefVideo.pause();
    compareOwnVideo.pause();
    $('comparePlay').textContent = '▶︎';
    if (autosave) queueAutosave(300);
  }

  async function playComparison() {
    const master = compareMasterVideo();
    if (!master) {
      $('markerList').textContent = '動画を1本以上選んでください';
      return;
    }
    if (comparePlaying) {
      pauseComparison();
      renderMarkers();
      return;
    }
    const bounds = compareBounds();
    if (bounds.max && compareCurrentTime >= bounds.max - 0.02) setCompareTime(bounds.min, false);
    comparePlaying = true;
    $('comparePlay').textContent = '❚❚';
    const promises = [compareRefVideo, compareOwnVideo]
      .filter(item => item.src && item.readyState >= 1)
      .map(item => item.play().catch(() => null));
    await Promise.all(promises);
  }

  function stepCompareFrames(amount) {
    pauseComparison(false);
    setCompareTime(compareCurrentTime + amount / fps());
  }

  function markerLabel(type) {
    return type === 'fix' ? '要修正' : type === 'ok' ? 'OK' : '確認';
  }

  function renderMarkers() {
    const track = $('markerTrack');
    track.querySelectorAll('.marker-dot').forEach(element => element.remove());
    const bounds = compareBounds();
    const minFrame = Math.round(bounds.min * fps());
    const maxFrame = bounds.max
      ? Math.max(minFrame + 1, Math.round(bounds.max * fps()))
      : Math.max(1, ...compareMarkers.map(marker => marker.frame));
    [...compareMarkers]
      .sort((a, b) => a.frame - b.frame)
      .forEach(marker => {
        const dot = document.createElement('button');
        dot.className = `marker-dot ${marker.type}`;
        const percent = clamp(((marker.frame - minFrame) / (maxFrame - minFrame)) * 100, 1.5, 98.5);
        dot.style.left = `${percent}%`;
        dot.dataset.id = marker.id;
        dot.title = `${marker.frame}F ${markerLabel(marker.type)}`;
        track.append(dot);
      });

    const list = $('markerList');
    list.replaceChildren();
    if (!compareMarkers.length) {
      const emptyItem = document.createElement('div');
      emptyItem.className = 'status';
      emptyItem.textContent = 'マーカーはまだありません';
      list.append(emptyItem);
      return;
    }
    [...compareMarkers]
      .sort((a, b) => a.frame - b.frame)
      .forEach(marker => {
        const item = document.createElement('div');
        item.className = 'marker-item';
        item.dataset.id = marker.id;
        const kind = document.createElement('span');
        kind.className = `marker-kind ${marker.type}`;
        const frameButton = document.createElement('button');
        frameButton.className = 'frame-chip';
        frameButton.dataset.action = 'seek';
        frameButton.textContent = `${marker.frame}F`;
        const label = document.createElement('div');
        label.textContent = marker.note
          ? `${markerLabel(marker.type)}：${marker.note}`
          : markerLabel(marker.type);
        const actions = document.createElement('div');
        actions.className = 'marker-actions';
        const edit = document.createElement('button');
        edit.className = 'layer-mini';
        edit.dataset.action = 'edit';
        edit.textContent = '✎';
        const remove = document.createElement('button');
        remove.className = 'icon-btn';
        remove.dataset.action = 'delete';
        remove.textContent = '×';
        actions.append(edit, remove);
        item.append(kind, frameButton, label, actions);
        list.append(item);
      });
  }

  function addCompareMarker(type) {
    const targetFrame = Math.max(0, Math.round(compareCurrentTime * fps()));
    const existing = compareMarkers.find(marker => marker.frame === targetFrame);
    const note = prompt('マーカーメモ（空欄でもOK）', existing?.note || '');
    if (note === null) return;
    if (existing) {
      existing.type = type;
      existing.note = note.trim().slice(0, 160);
    } else {
      compareMarkers.push({
        id: uid(),
        frame: targetFrame,
        type,
        note: note.trim().slice(0, 160)
      });
    }
    renderMarkers();
    queueAutosave();
  }

  function applyCompareTransforms() {
    const apply = (element, transform) => {
      const flip = transform.flip ? -1 : 1;
      element.style.transform = `translate3d(${transform.x}%, ${transform.y}%, 0) scale(${transform.scale * flip}, ${transform.scale})`;
    };
    apply(compareRefVideo, compareTransforms.ref);
    apply(compareOwnVideo, compareTransforms.own);
  }

  function updateCompareAdjustControls() {
    const transform = compareTransforms[compareAdjustTarget];
    $('adjustRef').classList.toggle('active', compareAdjustTarget === 'ref');
    $('adjustOwn').classList.toggle('active', compareAdjustTarget === 'own');
    $('compareScale').value = String(Math.round(transform.scale * 100));
    $('compareScaleValue').textContent = String(Math.round(transform.scale * 100));
    $('flipCompare').classList.toggle('primary', transform.flip);
    $('flipCompare').textContent = transform.flip ? '左右反転 ON' : '左右反転';
    applyCompareTransforms();
  }

  function renderCompareUi() {
    const overlay = compareMode === 'overlay';
    const difference = compareMode === 'difference';
    $('compareVideos').classList.toggle('overlay', overlay);
    $('compareVideos').classList.toggle('difference', difference);
    $('compareMode').value = compareMode;
    $('compareVideos').style.setProperty('--compare-opacity', String(compareOpacity));
    $('compareOpacity').value = String(Math.round(compareOpacity * 100));
    $('compareOpacityValue').textContent = String(Math.round(compareOpacity * 100));
    $('syncRefFrame').value = String(Math.round(compareSyncRefTime * fps()));
    $('syncOwnFrame').value = String(Math.round(compareSyncOwnTime * fps()));
    $('compareSetA').textContent = compareA === null ? '比較A点' : `A ${Math.round(compareA * fps())}F`;
    $('compareSetB').textContent = compareB === null ? '比較B点' : `B ${Math.round(compareB * fps())}F`;
    $('compareLoop').textContent = `ABループ ${compareLoopOn ? 'ON' : 'OFF'}`;
    $('compareLoop').classList.toggle('primary', compareLoopOn);
    updateCompareAdjustControls();
    updateCompareHud();
    renderMarkers();
  }

  function comparisonLoop() {
    if (comparePlaying) {
      const master = compareMasterVideo();
      if (master) {
        compareCurrentTime = master === compareOwnVideo && !compareRefVideo.src
          ? master.currentTime || 0
          : master.currentTime || 0;
        if (compareLoopOn && compareA !== null && compareB !== null
          && compareB > compareA && compareCurrentTime >= compareB) {
          setCompareTime(compareA, false);
          requestAnimationFrame(comparisonLoop);
          return;
        }
        const follower = master === compareRefVideo ? compareOwnVideo : compareRefVideo;
        const mapped = mappedCompareTimes(compareCurrentTime);
        const followerTarget = follower === compareOwnVideo ? mapped.own : mapped.ref;
        if (follower.src && follower.readyState >= 1 && Math.abs(follower.currentTime - followerTarget) > 0.055) {
          follower.currentTime = clamp(followerTarget, 0, Math.max(0, follower.duration - 0.001));
        }
        const bounds = compareBounds();
        if ((bounds.max && compareCurrentTime >= bounds.max - 0.015) || master.ended) pauseComparison();
        updateCompareHud();
      }
    }
    requestAnimationFrame(comparisonLoop);
  }

  function applyCompareSyncPoints() {
    const refFrame = Math.max(0, Number($('syncRefFrame').value) || 0);
    const ownFrame = Math.max(0, Number($('syncOwnFrame').value) || 0);
    compareSyncRefTime = refFrame / fps();
    compareSyncOwnTime = ownFrame / fps();
    if (Number.isFinite(compareRefVideo.duration)) {
      compareSyncRefTime = clamp(compareSyncRefTime, 0, Math.max(0, compareRefVideo.duration - 0.001));
    }
    if (Number.isFinite(compareOwnVideo.duration)) {
      compareSyncOwnTime = clamp(compareSyncOwnTime, 0, Math.max(0, compareOwnVideo.duration - 0.001));
    }
    pauseComparison(false);
    setCompareTime(compareSyncRefTime, false);
    renderCompareUi();
    queueAutosave();
  }

  function comparePointerPairMetrics() {
    const pair = [...comparePointers.values()].slice(0, 2);
    if (pair.length < 2) return null;
    return {
      distance: Math.max(1, Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y)),
      centerX: (pair[0].x + pair[1].x) / 2,
      centerY: (pair[0].y + pair[1].y) / 2
    };
  }

  function beginCompareTransformGesture() {
    const rect = $('compareVideos').getBoundingClientRect();
    const transform = compareTransforms[compareAdjustTarget];
    if (comparePointers.size >= 2) {
      const metrics = comparePointerPairMetrics();
      compareGesture = {
        type: 'pinch',
        ...metrics,
        scale: transform.scale,
        x: transform.x,
        y: transform.y,
        width: rect.width,
        height: rect.height
      };
    } else {
      const point = [...comparePointers.values()][0];
      compareGesture = {
        type: 'drag',
        startX: point.x,
        startY: point.y,
        x: transform.x,
        y: transform.y,
        width: rect.width,
        height: rect.height
      };
    }
  }

  function updateCompareTransformGesture() {
    if (!compareGesture) return;
    const transform = compareTransforms[compareAdjustTarget];
    if (comparePointers.size >= 2 && compareGesture.type === 'pinch') {
      const metrics = comparePointerPairMetrics();
      transform.scale = clamp(compareGesture.scale * (metrics.distance / compareGesture.distance), 0.5, 3);
      transform.x = clamp(
        compareGesture.x + ((metrics.centerX - compareGesture.centerX) / compareGesture.width) * 100,
        -100,
        100
      );
      transform.y = clamp(
        compareGesture.y + ((metrics.centerY - compareGesture.centerY) / compareGesture.height) * 100,
        -100,
        100
      );
    } else if (comparePointers.size === 1 && compareGesture.type === 'drag') {
      const point = [...comparePointers.values()][0];
      transform.x = clamp(compareGesture.x + ((point.x - compareGesture.startX) / compareGesture.width) * 100, -100, 100);
      transform.y = clamp(compareGesture.y + ((point.y - compareGesture.startY) / compareGesture.height) * 100, -100, 100);
    }
    updateCompareAdjustControls();
  }

  function drawVideoInBox(context, source, box, transform, fillBackground = true) {
    context.save();
    context.beginPath();
    context.rect(box.x, box.y, box.width, box.height);
    context.clip();
    if (fillBackground) {
      context.fillStyle = '#000';
      context.fillRect(box.x, box.y, box.width, box.height);
    }
    if (source.readyState >= 2 && source.videoWidth && source.videoHeight) {
      const fit = Math.min(box.width / source.videoWidth, box.height / source.videoHeight);
      const width = source.videoWidth * fit;
      const height = source.videoHeight * fit;
      context.translate(
        box.x + box.width / 2 + (transform.x / 100) * box.width,
        box.y + box.height / 2 + (transform.y / 100) * box.height
      );
      context.scale(transform.scale * (transform.flip ? -1 : 1), transform.scale);
      context.drawImage(source, -width / 2, -height / 2, width, height);
    }
    context.restore();
  }

  async function saveComparisonImage() {
    if (!compareRefVideo.videoWidth && !compareOwnVideo.videoWidth) {
      $('markerList').textContent = '動画を先に選んでください';
      return;
    }
    const side = compareMode === 'side';
    const output = document.createElement('canvas');
    output.width = side ? 1920 : 1280;
    output.height = side ? 540 : 720;
    const context = output.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, output.width, output.height);
    if (side) {
      drawVideoInBox(context, compareRefVideo, { x: 0, y: 0, width: 960, height: 540 }, compareTransforms.ref);
      drawVideoInBox(context, compareOwnVideo, { x: 960, y: 0, width: 960, height: 540 }, compareTransforms.own);
    } else {
      const box = { x: 0, y: 0, width: output.width, height: output.height };
      drawVideoInBox(context, compareRefVideo, box, compareTransforms.ref);
      context.save();
      if (compareMode === 'difference') context.globalCompositeOperation = 'difference';
      else context.globalAlpha = compareOpacity;
      drawVideoInBox(context, compareOwnVideo, box, compareTransforms.own, false);
      context.restore();
    }
    const mapped = mappedCompareTimes(compareCurrentTime);
    context.fillStyle = '#000a';
    context.fillRect(0, output.height - 54, output.width, 54);
    context.fillStyle = '#fff';
    context.font = '700 24px sans-serif';
    context.textBaseline = 'middle';
    context.fillText(
      `参考 ${Math.round(mapped.ref * fps())}F / 自作 ${Math.round(mapped.own * fps())}F`,
      22,
      output.height - 27
    );
    output.toBlob(blob => {
      if (blob) downloadBlob(blob, `${safeFilename(projectName)}_compare_${Math.round(compareCurrentTime * fps())}F.png`);
    }, 'image/png');
  }

  const analysisFrame = () => Math.max(0, Math.round(analysisCurrentTime * fps()));

  function sizeAnalysisCanvas(canvas, context) {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function resizeAnalysisCanvases() {
    sizeAnalysisCanvas(onionCanvas, onionCtx);
    sizeAnalysisCanvas(guideCanvas, guideCtx);
    sizeAnalysisCanvas(analysisOverlayCanvas, analysisOverlayCtx);
    renderGuideCanvas();
    renderAnalysisOverlay();
    renderOnionSkin();
  }

  function analysisPointFromEvent(event) {
    const rect = analysisOverlayCanvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (analysisOverlayCanvas.clientWidth / rect.width),
      y: (event.clientY - rect.top) * (analysisOverlayCanvas.clientHeight / rect.height)
    };
  }

  function prepareGuideContext() {
    guideCtx.lineWidth = guideSize;
    guideCtx.lineCap = 'round';
    guideCtx.lineJoin = 'round';
    guideCtx.strokeStyle = guideColor;
    guideCtx.fillStyle = guideColor;
    guideCtx.globalCompositeOperation = 'source-over';
  }

  function drawContained(context, source, width, height) {
    const sourceWidth = source.videoWidth || source.width;
    const sourceHeight = source.videoHeight || source.height;
    if (!sourceWidth || !sourceHeight) return;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(
      source,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
  }

  function waitForMediaEvent(element, eventName, timeout = 1800) {
    return new Promise(resolve => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        element.removeEventListener(eventName, finish);
        resolve();
      };
      element.addEventListener(eventName, finish, { once: true });
      timer = setTimeout(finish, timeout);
    });
  }

  async function captureOnionFrameNow(targetFrame) {
    if (onionFrameCache.has(targetFrame)) return onionFrameCache.get(targetFrame);
    if (!analysisFrameLoader.src || analysisFrameLoader.readyState < 1) return null;
    const targetTime = clamp(
      targetFrame / fps(),
      0,
      Math.max(0, analysisFrameLoader.duration - 0.001)
    );
    if (analysisFrameLoader.readyState < 2) await waitForMediaEvent(analysisFrameLoader, 'loadeddata');
    if (Math.abs(analysisFrameLoader.currentTime - targetTime) > 0.0005) {
      analysisFrameLoader.currentTime = targetTime;
      await waitForMediaEvent(analysisFrameLoader, 'seeked');
    }
    if (!analysisFrameLoader.videoWidth) return null;
    const snapshot = document.createElement('canvas');
    const scale = Math.min(1, 640 / analysisFrameLoader.videoWidth);
    snapshot.width = Math.max(2, Math.round(analysisFrameLoader.videoWidth * scale));
    snapshot.height = Math.max(2, Math.round(analysisFrameLoader.videoHeight * scale));
    snapshot.getContext('2d').drawImage(analysisFrameLoader, 0, 0, snapshot.width, snapshot.height);
    onionFrameCache.set(targetFrame, snapshot);
    if (onionFrameCache.size > 30) {
      const first = onionFrameCache.keys().next().value;
      onionFrameCache.delete(first);
    }
    return snapshot;
  }

  function captureOnionFrame(targetFrame) {
    if (onionFrameCache.has(targetFrame)) return Promise.resolve(onionFrameCache.get(targetFrame));
    if (onionFramePromises.has(targetFrame)) return onionFramePromises.get(targetFrame);
    const capture = onionCaptureChain.then(() => captureOnionFrameNow(targetFrame));
    onionCaptureChain = capture.catch(() => null);
    onionFramePromises.set(targetFrame, capture);
    capture.then(
      () => onionFramePromises.delete(targetFrame),
      () => onionFramePromises.delete(targetFrame)
    );
    return capture;
  }

  async function renderOnionSkin() {
    const token = ++analysisRenderToken;
    clearContext(onionCtx, onionCanvas);
    if (!onionEnabled || analysisPlaying || !analysisVideo.src || analysisVideo.readyState < 1) return;
    const current = analysisFrame();
    const totalFrames = Math.max(0, Math.floor((analysisVideo.duration || 0) * fps()));
    const targets = [];
    for (let distance = Math.max(onionPrev, onionNext); distance >= 1; distance -= 1) {
      if (distance <= onionPrev && current - distance >= 0) targets.push({ frame: current - distance, distance, previous: true });
      if (distance <= onionNext && current + distance <= totalFrames) targets.push({ frame: current + distance, distance, previous: false });
    }
    for (const target of targets) {
      const snapshot = await captureOnionFrame(target.frame);
      if (token !== analysisRenderToken) return;
      if (!snapshot) continue;
      onionCtx.save();
      onionCtx.globalAlpha = onionOpacity / Math.max(1, target.distance * 0.8);
      onionCtx.globalCompositeOperation = 'screen';
      onionCtx.filter = target.previous
        ? 'sepia(1) saturate(4) hue-rotate(145deg)'
        : 'sepia(1) saturate(5) hue-rotate(315deg)';
      drawContained(onionCtx, snapshot, onionCanvas.clientWidth, onionCanvas.clientHeight);
      onionCtx.restore();
    }
  }

  function renderGuideCanvas() {
    clearContext(guideCtx, guideCanvas);
    guideCanvas.style.opacity = guideVisible ? '1' : '0';
    if (!guideData) return;
    const image = new Image();
    image.onload = () => {
      clearContext(guideCtx, guideCanvas);
      guideCtx.drawImage(image, 0, 0, guideCanvas.clientWidth, guideCanvas.clientHeight);
    };
    image.src = guideData;
  }

  function saveGuideCanvas() {
    guideData = guideCanvas.toDataURL('image/png');
    queueAutosave();
  }

  function renderAnalysisOverlay() {
    clearContext(analysisOverlayCtx, analysisOverlayCanvas);
    ensureTrackers();
    const width = analysisOverlayCanvas.clientWidth;
    const height = analysisOverlayCanvas.clientHeight;
    const current = analysisFrame();
    trackers.forEach(tracker => {
      const points = Object.entries(tracker.points || {})
        .map(([frameNumber, point]) => ({ frame: Number(frameNumber), ...point }))
        .filter(point => Number.isFinite(point.frame) && Number.isFinite(point.x) && Number.isFinite(point.y))
        .sort((a, b) => a.frame - b.frame);
      if (!points.length) return;
      analysisOverlayCtx.save();
      analysisOverlayCtx.strokeStyle = tracker.color;
      analysisOverlayCtx.fillStyle = tracker.color;
      analysisOverlayCtx.lineWidth = 3;
      analysisOverlayCtx.lineCap = 'round';
      analysisOverlayCtx.lineJoin = 'round';
      analysisOverlayCtx.globalAlpha = tracker.id === activeTrackerId ? 1 : 0.62;
      analysisOverlayCtx.beginPath();
      points.forEach((point, index) => {
        const x = point.x * width;
        const y = point.y * height;
        if (index === 0) analysisOverlayCtx.moveTo(x, y);
        else analysisOverlayCtx.lineTo(x, y);
      });
      analysisOverlayCtx.stroke();
      points.forEach(point => {
        const x = point.x * width;
        const y = point.y * height;
        analysisOverlayCtx.beginPath();
        analysisOverlayCtx.arc(x, y, point.frame === current ? 7 : 4, 0, Math.PI * 2);
        analysisOverlayCtx.fill();
        if (point.frame === current) {
          analysisOverlayCtx.strokeStyle = '#fff';
          analysisOverlayCtx.lineWidth = 2;
          analysisOverlayCtx.stroke();
          analysisOverlayCtx.strokeStyle = tracker.color;
          analysisOverlayCtx.lineWidth = 3;
        }
      });
      const last = points[points.length - 1];
      analysisOverlayCtx.font = '700 12px sans-serif';
      analysisOverlayCtx.fillText(tracker.name, last.x * width + 8, last.y * height - 8);
      analysisOverlayCtx.restore();
    });
  }

  function renderTrackerList() {
    ensureTrackers();
    const list = $('trackerList');
    list.replaceChildren();
    trackers.forEach(tracker => {
      const button = document.createElement('button');
      button.className = `tracker-chip${tracker.id === activeTrackerId ? ' active' : ''}`;
      button.dataset.id = tracker.id;
      const dot = document.createElement('span');
      dot.className = 'tracker-dot';
      dot.style.background = tracker.color;
      const name = document.createElement('span');
      name.textContent = `${tracker.name} (${Object.keys(tracker.points || {}).length})`;
      button.append(dot, name);
      list.append(button);
    });
  }

  function phaseTotalFrames() {
    return Math.max(
      1,
      Math.round((analysisVideo.duration || 0) * fps()),
      ...Object.values(analysisPhases).filter(Number.isFinite),
      ...keyPoses.map(pose => pose.frame)
    );
  }

  function renderPhaseBar() {
    const bar = $('phaseBar');
    bar.replaceChildren();
    const total = phaseTotalFrames();
    const anticipation = clamp(analysisPhases.anticipation ?? 0, 0, total);
    const action = clamp(analysisPhases.action ?? anticipation, anticipation, total);
    const follow = clamp(analysisPhases.follow ?? action, action, total);
    const end = clamp(analysisPhases.end ?? total, follow, total);
    const parts = [
      { start: 0, end: anticipation, type: 'other', label: '' },
      { start: anticipation, end: action, type: 'anticipation', label: '予備動作' },
      { start: action, end: follow, type: 'action', label: '本動作' },
      { start: follow, end, type: 'follow', label: 'フォロー' },
      { start: end, end: total, type: 'other', label: '' }
    ].filter(part => part.end > part.start);
    parts.forEach(part => {
      const segment = document.createElement('div');
      segment.className = `phase-segment ${part.type}`;
      segment.style.flexGrow = String(part.end - part.start);
      segment.textContent = part.label;
      bar.append(segment);
    });
    const cursor = document.createElement('div');
    cursor.className = 'phase-cursor';
    bar.append(cursor);
    updatePhaseCursor();
    $('phaseAnticipation').textContent = analysisPhases.anticipation === null
      ? '予備動作'
      : `予備 ${analysisPhases.anticipation}F`;
    $('phaseAction').textContent = analysisPhases.action === null ? '本動作' : `本動作 ${analysisPhases.action}F`;
    $('phaseFollow').textContent = analysisPhases.follow === null
      ? 'フォロースルー'
      : `フォロー ${analysisPhases.follow}F`;
    $('phaseEnd').textContent = analysisPhases.end === null ? '終了' : `終了 ${analysisPhases.end}F`;
  }

  function updatePhaseCursor() {
    const cursor = $('phaseBar').querySelector('.phase-cursor');
    if (!cursor) return;
    cursor.style.left = `${clamp((analysisFrame() / phaseTotalFrames()) * 100, 0, 100)}%`;
  }

  function renderKeyPoses() {
    const grid = $('poseGrid');
    grid.replaceChildren();
    if (!keyPoses.length) {
      const item = document.createElement('div');
      item.className = 'status';
      item.textContent = '重要ポーズはまだありません';
      grid.append(item);
      return;
    }
    [...keyPoses].sort((a, b) => a.frame - b.frame).forEach(pose => {
      const card = document.createElement('div');
      card.className = 'pose-card';
      card.dataset.id = pose.id;
      const image = document.createElement('img');
      image.className = 'pose-thumb';
      image.src = pose.thumbnail;
      image.alt = `${pose.frame}F`;
      const info = document.createElement('div');
      info.className = 'pose-info';
      const seek = document.createElement('button');
      seek.className = 'frame-chip';
      seek.dataset.action = 'seek';
      seek.textContent = `${pose.frame}F`;
      const note = document.createElement('div');
      note.className = 'pose-note';
      note.textContent = pose.note || '重要ポーズ';
      const actions = document.createElement('div');
      actions.className = 'marker-actions';
      const edit = document.createElement('button');
      edit.className = 'layer-mini';
      edit.dataset.action = 'edit';
      edit.textContent = '✎';
      const remove = document.createElement('button');
      remove.className = 'layer-mini delete';
      remove.dataset.action = 'delete';
      remove.textContent = '×';
      actions.append(edit, remove);
      info.append(seek, note, actions);
      card.append(image, info);
      grid.append(card);
    });
  }

  function renderAnalysisUi() {
    $('onionPrev').value = String(onionPrev);
    $('onionNext').value = String(onionNext);
    $('onionOpacity').value = String(Math.round(onionOpacity * 100));
    $('onionOpacityValue').textContent = String(Math.round(onionOpacity * 100));
    $('toggleOnion').textContent = `オニオン ${onionEnabled ? 'ON' : 'OFF'}`;
    $('toggleOnion').classList.toggle('primary', onionEnabled);
    $('trackMode').classList.toggle('active', analysisMode === 'track');
    $('guideMode').classList.toggle('active', analysisMode === 'guide');
    $('trackControls').classList.toggle('hidden', analysisMode !== 'track');
    $('guideControls').classList.toggle('hidden', analysisMode !== 'guide');
    $('guidePen').classList.toggle('primary', guideTool === 'pen');
    $('guideLine').classList.toggle('primary', guideTool === 'line');
    $('toggleGuide').textContent = `ガイド ${guideVisible ? 'ON' : 'OFF'}`;
    $('toggleGuide').classList.toggle('primary', guideVisible);
    document.querySelectorAll('.guide-color').forEach(button => {
      button.classList.toggle('active', button.dataset.guideColor === guideColor);
    });
    renderTrackerList();
    renderPhaseBar();
    renderKeyPoses();
    updateAnalysisHud();
    renderGuideCanvas();
    renderAnalysisOverlay();
    renderOnionSkin();
  }

  function updateAnalysisHud() {
    $('analysisFrameHud').textContent = `F ${analysisFrame()}`;
    $('analysisTimeHud').textContent = fmtTime(analysisCurrentTime);
    if (analysisVideo.duration) {
      $('analysisScrub').value = String(Math.round((analysisCurrentTime / analysisVideo.duration) * 1000));
    } else {
      $('analysisScrub').value = '0';
    }
    updatePhaseCursor();
  }

  function setAnalysisTime(time, autosave = true) {
    const max = analysisVideo.duration ? Math.max(0, analysisVideo.duration - 0.001) : Math.max(0, Number(time) || 0);
    analysisCurrentTime = clamp(Number(time) || 0, 0, max);
    if (analysisVideo.src && analysisVideo.readyState >= 1) analysisVideo.currentTime = analysisCurrentTime;
    updateAnalysisHud();
    renderAnalysisOverlay();
    renderOnionSkin();
    if (autosave) queueAutosave(900);
  }

  function pauseAnalysis(autosave = true) {
    analysisPlaying = false;
    analysisVideo.pause();
    $('analysisPlay').textContent = '▶︎';
    renderOnionSkin();
    if (autosave) queueAutosave(300);
  }

  function stepAnalysisFrames(amount) {
    pauseAnalysis(false);
    setAnalysisTime(analysisCurrentTime + amount / fps());
  }

  function analysisLoop() {
    if (analysisPlaying) {
      analysisCurrentTime = analysisVideo.currentTime || 0;
      updateAnalysisHud();
      renderAnalysisOverlay();
      if (analysisVideo.ended) pauseAnalysis();
    }
    requestAnimationFrame(analysisLoop);
  }

  function captureAnalysisPoseThumbnail() {
    if (!analysisVideo.videoWidth) return null;
    const output = document.createElement('canvas');
    output.width = 480;
    output.height = 270;
    const context = output.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, output.width, output.height);
    drawContained(context, analysisVideo, output.width, output.height);
    if (guideVisible && guideData) context.drawImage(guideCanvas, 0, 0, output.width, output.height);
    context.drawImage(analysisOverlayCanvas, 0, 0, output.width, output.height);
    return output.toDataURL('image/jpeg', 0.86);
  }

  function addCurrentKeyPose() {
    const thumbnail = captureAnalysisPoseThumbnail();
    if (!thumbnail) {
      $('poseGrid').textContent = '動画を先に選んでください';
      return;
    }
    const current = analysisFrame();
    const existing = keyPoses.find(pose => pose.frame === current);
    const note = prompt('このポーズのメモ（空欄でもOK）', existing?.note || '');
    if (note === null) return;
    if (existing) {
      existing.note = note.trim().slice(0, 120);
      existing.thumbnail = thumbnail;
    } else {
      keyPoses.push({
        id: uid(),
        frame: current,
        note: note.trim().slice(0, 120),
        thumbnail
      });
    }
    renderKeyPoses();
    renderPhaseBar();
    queueAutosave();
  }

  async function saveAnalysisSheet() {
    if (!keyPoses.length) {
      $('poseGrid').textContent = '重要ポーズを1枚以上追加してください';
      return;
    }
    const poses = [...keyPoses].sort((a, b) => a.frame - b.frame);
    const columns = 3;
    const cellWidth = 500;
    const cellHeight = 340;
    const headerHeight = 170;
    const rows = Math.ceil(poses.length / columns);
    const output = document.createElement('canvas');
    output.width = columns * cellWidth;
    output.height = headerHeight + rows * cellHeight + 30;
    const context = output.getContext('2d');
    context.fillStyle = '#0b0d11';
    context.fillRect(0, 0, output.width, output.height);
    context.fillStyle = '#fff';
    context.font = '800 42px sans-serif';
    context.fillText(`${projectName}・アニメーション分析`, 34, 54);
    context.fillStyle = '#aeb6c8';
    context.font = '600 24px sans-serif';
    const phaseText = [
      ['予備動作', analysisPhases.anticipation],
      ['本動作', analysisPhases.action],
      ['フォロースルー', analysisPhases.follow],
      ['終了', analysisPhases.end]
    ].filter(([, value]) => value !== null).map(([label, value]) => `${label} ${value}F`).join(' ／ ');
    context.fillText(phaseText || '動作区間：未設定', 34, 98);
    const trackerText = trackers
      .map(tracker => `${tracker.name} ${Object.keys(tracker.points || {}).length}点`)
      .join(' ／ ');
    context.fillText(trackerText || '軌跡：未設定', 34, 136);

    for (let index = 0; index < poses.length; index += 1) {
      const pose = poses[index];
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * cellWidth + 18;
      const y = headerHeight + row * cellHeight;
      const image = await getImage(pose.thumbnail);
      context.fillStyle = '#151821';
      context.fillRect(x, y, cellWidth - 36, cellHeight - 18);
      if (image) context.drawImage(image, x + 8, y + 8, cellWidth - 52, 252);
      context.fillStyle = '#ff4fa3';
      context.font = '800 28px sans-serif';
      context.fillText(`${pose.frame}F`, x + 12, y + 296);
      context.fillStyle = '#fff';
      context.font = '600 20px sans-serif';
      context.fillText((pose.note || '重要ポーズ').slice(0, 28), x + 100, y + 296);
    }
    output.toBlob(blob => {
      if (blob) downloadBlob(blob, `${safeFilename(projectName)}_analysis-sheet.png`);
    }, 'image/png');
  }

  function renderMemos() {
    const search = ($('memoSearch').value || '').trim().toLowerCase();
    const list = $('noteList');
    list.replaceChildren();
    const filtered = [...memos]
      .sort((a, b) => (a.frame ?? -1) - (b.frame ?? -1) || a.createdAt - b.createdAt)
      .filter(memo => !search || memo.text.toLowerCase().includes(search));
    if (!filtered.length) {
      const item = document.createElement('div');
      item.className = 'status';
      item.textContent = search ? '一致するメモはありません' : 'メモはまだありません';
      list.append(item);
      return;
    }
    filtered.forEach(memo => {
      const item = document.createElement('div');
      item.className = 'note-item';
      item.dataset.id = memo.id;
      const chip = document.createElement('button');
      chip.className = 'frame-chip';
      chip.dataset.action = 'seek';
      chip.textContent = memo.frame === null ? '全体' : `${memo.frame}F`;
      chip.disabled = memo.frame === null;
      const text = document.createElement('div');
      text.className = 'note-text';
      text.textContent = memo.text;
      const remove = document.createElement('button');
      remove.className = 'icon-btn';
      remove.dataset.action = 'delete';
      remove.setAttribute('aria-label', 'メモを削除');
      remove.textContent = '×';
      item.append(chip, text, remove);
      list.append(item);
    });
  }

  function saveMemo(targetFrame) {
    const text = $('memoInput').value.trim();
    if (!text) {
      setStatus('メモを入力してください');
      return;
    }
    memos.push({
      id: uid(),
      frame: targetFrame,
      text,
      createdAt: Date.now()
    });
    memoDraft = '';
    memoDraftFrame = frame();
    $('memoInput').value = '';
    renderMemos();
    queueAutosave();
  }

  async function compositeAnnotations(context, targetFrame, width, height) {
    if (!layersGloballyVisible) return;
    for (const layer of [...layers].reverse()) {
      if (!layer.visible) continue;
      if (layer.frames[targetFrame]) {
        const image = await getImage(layer.frames[targetFrame]);
        if (image) context.drawImage(image, 0, 0, width, height);
      }
      drawLayerTexts(context, layer.id, targetFrame, width, height);
    }
  }

  async function compositeCurrentFrame() {
    if (!video.videoWidth || !video.videoHeight) throw new Error('動画を先に選んでください');
    const output = document.createElement('canvas');
    output.width = video.videoWidth;
    output.height = video.videoHeight;
    const context = output.getContext('2d');
    context.drawImage(video, 0, 0, output.width, output.height);
    await compositeAnnotations(context, frame(), output.width, output.height);
    return output;
  }

  function downloadBlob(blob, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  function safeFilename(name) {
    return (name || 'animation-project').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'animation-project';
  }

  async function exportAnnotatedVideo() {
    const exportStatus = $('exportStatus');
    const progress = $('exportProgress');
    if (!video.src || !video.videoWidth) {
      exportStatus.textContent = '動画を先に選んでください';
      return;
    }
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      exportStatus.textContent = 'この端末は動画書き出しに対応していません。画像保存をご利用ください';
      return;
    }

    const outputFps = clamp(Number($('exportFps').value) || 30, 1, 60);
    const scale = clamp(Number($('exportScale').value) || 1, 0.25, 1);
    const output = document.createElement('canvas');
    output.width = Math.max(2, Math.round(video.videoWidth * scale));
    output.height = Math.max(2, Math.round(video.videoHeight * scale));
    const context = output.getContext('2d');
    const stream = output.captureStream(outputFps);
    const sourceStream = video.captureStream?.() || video.mozCaptureStream?.();
    sourceStream?.getAudioTracks?.().forEach(track => stream.addTrack(track));
    const mimeCandidates = [
      'video/mp4;codecs=h264',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    const mime = mimeCandidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (error) {
      console.error(error);
      exportStatus.textContent = 'この端末では動画書き出しを開始できませんでした';
      return;
    }

    const chunks = [];
    recorder.ondataavailable = event => {
      if (event.data.size) chunks.push(event.data);
    };
    progress.classList.remove('hidden');
    progress.value = 0;
    exportStatus.textContent = '書き出し中…';
    const oldTime = video.currentTime;
    const oldRate = video.playbackRate;
    const wasPaused = video.paused;
    const exportStart = A !== null && B !== null && B > A ? A : 0;
    const exportEnd = A !== null && B !== null && B > A ? B : video.duration;
    video.pause();
    video.playbackRate = 1;
    video.currentTime = exportStart;
    await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));

    let stopped = false;
    const stopPromise = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
    recorder.start(500);

    const draw = async () => {
      if (stopped) return;
      context.drawImage(video, 0, 0, output.width, output.height);
      await compositeAnnotations(context, frame(), output.width, output.height);
      progress.value = clamp((video.currentTime - exportStart) / Math.max(0.001, exportEnd - exportStart), 0, 1);
      if (video.currentTime >= exportEnd || video.ended) {
        stopped = true;
        video.pause();
        recorder.stop();
        return;
      }
      requestAnimationFrame(draw);
    };

    try {
      await video.play();
      requestAnimationFrame(draw);
      await stopPromise;
      const type = recorder.mimeType || mime || 'video/webm';
      const extension = type.includes('mp4') ? 'mp4' : 'webm';
      downloadBlob(new Blob(chunks, { type }), `${safeFilename(projectName)}_annotated.${extension}`);
      progress.value = 1;
      exportStatus.textContent = `書き出しました（${extension.toUpperCase()}）`;
    } catch (error) {
      console.error(error);
      if (recorder.state !== 'inactive') recorder.stop();
      exportStatus.textContent = '書き出しに失敗しました';
    } finally {
      video.currentTime = oldTime;
      video.playbackRate = oldRate;
      if (!wasPaused) video.play().catch(() => {});
    }
  }

  function migrateImportedProject(raw) {
    const source = raw.project && typeof raw.project === 'object' ? raw.project : raw;
    const migrated = {
      ...source,
      id: uid(),
      name: source.name || source.projectName || '読み込んだプロジェクト',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      layers: normalizeLayers(source),
      activeLayerId: source.activeLayerId,
      layersGloballyVisible: source.layersGloballyVisible !== false,
      memos: Array.isArray(source.memos) ? source.memos : []
    };
    if (!migrated.activeLayerId || !migrated.layers.some(layer => layer.id === migrated.activeLayerId)) {
      migrated.activeLayerId = migrated.layers[0].id;
    }
    return migrated;
  }

  document.querySelectorAll('.tab').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.tab !== 'comparePanel' && comparePlaying) pauseComparison();
      if (button.dataset.tab !== 'analysisPanel' && analysisPlaying) pauseAnalysis();
      document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('active', panel.id === button.dataset.tab));
      if (button.dataset.tab === 'videoPanel') {
        requestAnimationFrame(() => resizeCanvases());
      } else if (button.dataset.tab === 'comparePanel') {
        video.pause();
        renderCompareUi();
      } else if (button.dataset.tab === 'analysisPanel') {
        video.pause();
        pauseComparison(false);
        requestAnimationFrame(() => {
          resizeAnalysisCanvases();
          setAnalysisTime(analysisCurrentTime, false);
          renderAnalysisUi();
        });
      } else if (button.dataset.tab === 'memoPanel') {
        $('memoFrameLabel').textContent = `${frame()}F`;
      } else if (button.dataset.tab === 'exportPanel') {
        renderProjectList();
      }
    });
  });

  async function handleMainVideoSelection(input) {
    const selected = input.files?.[0];
    if (!selected) return;
    ensureProjectId();
    pendingResumeTime = 0;
    try {
      setStatus('動画を読み込み中…');
      await loadVideoBlob(selected, selected.name);
      videoName = selected.name;
      if (projectName === '無題のプロジェクト') {
        projectName = selected.name.replace(/\.[^.]+$/, '') || projectName;
        $('projectNameInput').value = projectName;
      }
      try {
        const previous = await storeGet(VIDEO_STORE, projectId).catch(() => null);
        await storePut(VIDEO_STORE, {
          ...(previous || {}),
          projectId,
          name: selected.name,
          type: selected.type,
          size: selected.size,
          updatedAt: Date.now(),
          blob: selected
        });
      } catch (error) {
        console.error(error);
        setAutosaveStatus('error', '動画の端末保存に失敗しました。空き容量を確認してください');
      }
      await saveProjectNow({ refreshList: true });
      setStatus('動画を読み込み、自動保存しました');
    } catch (error) {
      console.error(error);
      setStatus('動画を読み込めませんでした');
    } finally {
      input.value = '';
    }
  }

  fileInput.addEventListener('change', () => handleMainVideoSelection(fileInput));
  $('compareRefFile').addEventListener('change', () => handleMainVideoSelection($('compareRefFile')));
  $('compareOwnFile').addEventListener('change', async event => {
    const input = event.target;
    const selected = input.files?.[0];
    if (!selected) return;
    ensureProjectId();
    try {
      await loadCompareOwnBlob(selected, selected.name);
      const previous = await storeGet(VIDEO_STORE, projectId).catch(() => null);
      await storePut(VIDEO_STORE, {
        ...(previous || {}),
        projectId,
        compareName: selected.name,
        compareType: selected.type,
        compareSize: selected.size,
        compareUpdatedAt: Date.now(),
        compareBlob: selected
      });
      compareOwnVideoName = selected.name;
      setCompareTime(compareCurrentTime, false);
      await saveProjectNow({ refreshList: true });
    } catch (error) {
      console.error(error);
      $('markerList').textContent = '自分の動画を読み込めませんでした';
    } finally {
      input.value = '';
    }
  });

  $('play').addEventListener('click', () => {
    if (!video.src) {
      setStatus('動画を先に選んでください');
      return;
    }
    if (video.paused) {
      video.play().catch(() => setStatus('再生できませんでした'));
    } else {
      video.pause();
    }
  });
  video.addEventListener('play', () => {
    $('play').textContent = '❚❚';
  });
  video.addEventListener('pause', () => {
    $('play').textContent = '▶︎';
    queueAutosave(250);
  });
  video.addEventListener('ended', () => {
    $('play').textContent = '▶︎';
    queueAutosave(250);
  });
  video.addEventListener('loadedmetadata', () => {
    empty.classList.add('hidden');
    resizeCanvases();
    updateHud(true);
  });
  video.addEventListener('timeupdate', () => {
    updateHud();
    queueAutosave(1400);
  });
  [compareRefVideo, compareOwnVideo].forEach(item => {
    item.addEventListener('loadedmetadata', () => {
      setCompareTime(compareCurrentTime, false);
      renderCompareUi();
    });
    item.addEventListener('ended', () => pauseComparison());
  });
  $('comparePlay').addEventListener('click', playComparison);
  $('compareBack5').addEventListener('click', () => stepCompareFrames(-5));
  $('compareBack1').addEventListener('click', () => stepCompareFrames(-1));
  $('compareNext1').addEventListener('click', () => stepCompareFrames(1));
  $('compareNext5').addEventListener('click', () => stepCompareFrames(5));
  $('compareScrub').addEventListener('input', event => {
    pauseComparison(false);
    const bounds = compareBounds();
    setCompareTime(bounds.min + (Number(event.target.value) / 1000) * (bounds.max - bounds.min));
  });
  $('compareMode').addEventListener('change', event => {
    compareMode = event.target.value;
    renderCompareUi();
    queueAutosave();
  });
  $('compareOpacity').addEventListener('input', event => {
    compareOpacity = clamp(Number(event.target.value) / 100, 0.1, 0.9);
    renderCompareUi();
    queueAutosave();
  });
  $('applySync').addEventListener('click', applyCompareSyncPoints);
  $('resetSync').addEventListener('click', () => {
    compareSyncRefTime = 0;
    compareSyncOwnTime = 0;
    setCompareTime(0, false);
    renderCompareUi();
    queueAutosave();
  });
  $('compareSetA').addEventListener('click', () => {
    compareA = compareCurrentTime;
    renderCompareUi();
    queueAutosave();
  });
  $('compareSetB').addEventListener('click', () => {
    compareB = compareCurrentTime;
    renderCompareUi();
    queueAutosave();
  });
  $('compareLoop').addEventListener('click', () => {
    if (!compareLoopOn && (compareA === null || compareB === null || compareB <= compareA)) {
      $('markerList').textContent = '比較A点、B点の順に設定してください';
      return;
    }
    compareLoopOn = !compareLoopOn;
    renderCompareUi();
    queueAutosave();
  });
  $('adjustRef').addEventListener('click', () => {
    compareAdjustTarget = 'ref';
    updateCompareAdjustControls();
  });
  $('adjustOwn').addEventListener('click', () => {
    compareAdjustTarget = 'own';
    updateCompareAdjustControls();
  });
  $('compareScale').addEventListener('input', event => {
    compareTransforms[compareAdjustTarget].scale = clamp(Number(event.target.value) / 100, 0.5, 3);
    updateCompareAdjustControls();
    queueAutosave();
  });
  $('flipCompare').addEventListener('click', () => {
    compareTransforms[compareAdjustTarget].flip = !compareTransforms[compareAdjustTarget].flip;
    updateCompareAdjustControls();
    queueAutosave();
  });
  $('resetCompareTransform').addEventListener('click', () => {
    compareTransforms[compareAdjustTarget] = { scale: 1, x: 0, y: 0, flip: false };
    updateCompareAdjustControls();
    queueAutosave();
  });
  $('saveCompareImage').addEventListener('click', saveComparisonImage);

  const compareSurface = $('compareVideos');
  compareSurface.addEventListener('pointerdown', event => {
    event.preventDefault();
    pauseComparison(false);
    try {
      compareSurface.setPointerCapture(event.pointerId);
    } catch (_) {}
    comparePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    beginCompareTransformGesture();
  });
  compareSurface.addEventListener('pointermove', event => {
    if (!comparePointers.has(event.pointerId)) return;
    event.preventDefault();
    comparePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    updateCompareTransformGesture();
  });
  const finishComparePointer = event => {
    if (!comparePointers.has(event.pointerId)) return;
    event.preventDefault();
    comparePointers.delete(event.pointerId);
    if (comparePointers.size) beginCompareTransformGesture();
    else {
      compareGesture = null;
      queueAutosave();
    }
  };
  compareSurface.addEventListener('pointerup', finishComparePointer);
  compareSurface.addEventListener('pointercancel', finishComparePointer);

  $('markerFix').addEventListener('click', () => addCompareMarker('fix'));
  $('markerCheck').addEventListener('click', () => addCompareMarker('check'));
  $('markerOk').addEventListener('click', () => addCompareMarker('ok'));
  $('markerTrack').addEventListener('click', event => {
    const dot = event.target.closest('.marker-dot');
    if (!dot) return;
    const marker = compareMarkers.find(item => item.id === dot.dataset.id);
    if (marker) setCompareTime(marker.frame / fps());
  });
  $('markerList').addEventListener('click', event => {
    const item = event.target.closest('.marker-item');
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!item || !action) return;
    const marker = compareMarkers.find(entry => entry.id === item.dataset.id);
    if (!marker) return;
    if (action === 'seek') setCompareTime(marker.frame / fps());
    else if (action === 'edit') {
      const note = prompt('マーカーメモ', marker.note || '');
      if (note === null) return;
      marker.note = note.trim().slice(0, 160);
      renderMarkers();
      queueAutosave();
    }
    else if (action === 'delete') {
      compareMarkers = compareMarkers.filter(entry => entry.id !== marker.id);
      renderMarkers();
      queueAutosave();
    }
  });

  analysisVideo.addEventListener('loadedmetadata', () => {
    $('analysisEmpty').classList.add('hidden');
    analysisVideo.playbackRate = Number(speedInput.value) || 1;
    setAnalysisTime(analysisCurrentTime, false);
    requestAnimationFrame(() => {
      resizeAnalysisCanvases();
      renderPhaseBar();
    });
  });
  analysisVideo.addEventListener('seeked', () => {
    analysisCurrentTime = analysisVideo.currentTime || 0;
    updateAnalysisHud();
    renderAnalysisOverlay();
    renderOnionSkin();
  });
  analysisVideo.addEventListener('play', () => {
    analysisPlaying = true;
    $('analysisPlay').textContent = '❚❚';
    analysisRenderToken += 1;
    clearContext(onionCtx, onionCanvas);
  });
  analysisVideo.addEventListener('pause', () => {
    analysisPlaying = false;
    $('analysisPlay').textContent = '▶︎';
    renderOnionSkin();
    queueAutosave(300);
  });
  analysisVideo.addEventListener('ended', () => pauseAnalysis());

  $('analysisPlay').addEventListener('click', () => {
    if (!analysisVideo.src || analysisVideo.readyState < 1) {
      $('poseGrid').textContent = '動画ページで参考動画を先に選んでください';
      return;
    }
    if (analysisVideo.paused) {
      analysisVideo.playbackRate = Number(speedInput.value) || 1;
      analysisVideo.play().catch(() => {
        $('poseGrid').textContent = '動画を再生できませんでした';
      });
    } else {
      pauseAnalysis();
    }
  });
  $('analysisBack5').addEventListener('click', () => stepAnalysisFrames(-5));
  $('analysisBack1').addEventListener('click', () => stepAnalysisFrames(-1));
  $('analysisNext1').addEventListener('click', () => stepAnalysisFrames(1));
  $('analysisNext5').addEventListener('click', () => stepAnalysisFrames(5));
  $('analysisScrub').addEventListener('input', event => {
    pauseAnalysis(false);
    if (analysisVideo.duration) {
      setAnalysisTime((Number(event.target.value) / 1000) * analysisVideo.duration);
    }
  });

  $('onionPrev').addEventListener('change', event => {
    onionPrev = clamp(Number(event.target.value) || 0, 0, 3);
    renderOnionSkin();
    queueAutosave();
  });
  $('onionNext').addEventListener('change', event => {
    onionNext = clamp(Number(event.target.value) || 0, 0, 3);
    renderOnionSkin();
    queueAutosave();
  });
  $('onionOpacity').addEventListener('input', event => {
    onionOpacity = clamp(Number(event.target.value) / 100, 0.05, 0.7);
    $('onionOpacityValue').textContent = String(Math.round(onionOpacity * 100));
    renderOnionSkin();
    queueAutosave();
  });
  $('toggleOnion').addEventListener('click', () => {
    onionEnabled = !onionEnabled;
    renderAnalysisUi();
    queueAutosave();
  });

  $('trackMode').addEventListener('click', () => {
    analysisMode = 'track';
    renderAnalysisUi();
    queueAutosave();
  });
  $('guideMode').addEventListener('click', () => {
    analysisMode = 'guide';
    renderAnalysisUi();
    queueAutosave();
  });
  $('addTracker').addEventListener('click', () => {
    const name = prompt('軌跡の名前', `軌跡 ${trackers.length + 1}`);
    if (name === null) return;
    const tracker = makeTracker(name.trim().slice(0, 40) || `軌跡 ${trackers.length + 1}`);
    trackers.push(tracker);
    activeTrackerId = tracker.id;
    renderTrackerList();
    renderAnalysisOverlay();
    queueAutosave();
  });
  $('renameTracker').addEventListener('click', () => {
    const tracker = activeTracker();
    const name = prompt('軌跡の名前', tracker.name);
    if (name === null || !name.trim()) return;
    tracker.name = name.trim().slice(0, 40);
    renderTrackerList();
    renderAnalysisOverlay();
    queueAutosave();
  });
  $('deleteTracker').addEventListener('click', () => {
    ensureTrackers();
    if (trackers.length <= 1) {
      $('trackerList').title = '軌跡は1つ以上必要です';
      return;
    }
    const tracker = activeTracker();
    if (Object.keys(tracker.points || {}).length && !confirm(`「${tracker.name}」と登録した点を削除しますか？`)) return;
    const index = trackers.findIndex(item => item.id === tracker.id);
    trackers.splice(index, 1);
    activeTrackerId = trackers[Math.min(index, trackers.length - 1)].id;
    renderTrackerList();
    renderAnalysisOverlay();
    queueAutosave();
  });
  $('deleteTrackPoint').addEventListener('click', () => {
    const tracker = activeTracker();
    delete tracker.points[analysisFrame()];
    renderTrackerList();
    renderAnalysisOverlay();
    queueAutosave();
  });
  $('trackerList').addEventListener('click', event => {
    const button = event.target.closest('.tracker-chip');
    if (!button || !trackers.some(tracker => tracker.id === button.dataset.id)) return;
    activeTrackerId = button.dataset.id;
    renderTrackerList();
    renderAnalysisOverlay();
    queueAutosave();
  });

  $('guidePen').addEventListener('click', () => {
    guideTool = 'pen';
    renderAnalysisUi();
    queueAutosave();
  });
  $('guideLine').addEventListener('click', () => {
    guideTool = 'line';
    renderAnalysisUi();
    queueAutosave();
  });
  $('toggleGuide').addEventListener('click', () => {
    guideVisible = !guideVisible;
    renderAnalysisUi();
    queueAutosave();
  });
  $('clearGuide').addEventListener('click', () => {
    if (guideData && !confirm('全フレーム共通ガイドを消去しますか？')) return;
    guideData = null;
    clearContext(guideCtx, guideCanvas);
    queueAutosave();
  });
  document.querySelectorAll('.guide-color').forEach(button => {
    button.addEventListener('click', () => {
      guideColor = button.dataset.guideColor;
      document.querySelectorAll('.guide-color').forEach(item => item.classList.toggle('active', item === button));
      queueAutosave();
    });
  });

  const setCurrentTrackerPoint = point => {
    if (!analysisVideo.src || !analysisVideo.videoWidth) return;
    const tracker = activeTracker();
    tracker.points[analysisFrame()] = {
      x: clamp(point.x / Math.max(1, analysisOverlayCanvas.clientWidth), 0, 1),
      y: clamp(point.y / Math.max(1, analysisOverlayCanvas.clientHeight), 0, 1)
    };
    renderTrackerList();
    renderAnalysisOverlay();
  };

  analysisOverlayCanvas.addEventListener('pointerdown', event => {
    if (!analysisVideo.src || !analysisVideo.videoWidth) return;
    event.preventDefault();
    pauseAnalysis(false);
    try {
      analysisOverlayCanvas.setPointerCapture(event.pointerId);
    } catch (_) {}
    const point = analysisPointFromEvent(event);
    if (analysisMode === 'track') {
      analysisTrackPointerId = event.pointerId;
      setCurrentTrackerPoint(point);
      return;
    }
    guidePointerId = event.pointerId;
    guideDrawing = true;
    guideStartPoint = point;
    guideLastPoint = point;
    guideSnapshot = guideCtx.getImageData(0, 0, guideCanvas.width, guideCanvas.height);
    prepareGuideContext();
    if (guideTool === 'pen') {
      guideCtx.beginPath();
      guideCtx.moveTo(point.x, point.y);
    }
  });
  analysisOverlayCanvas.addEventListener('pointermove', event => {
    if (event.pointerId === analysisTrackPointerId && analysisMode === 'track') {
      event.preventDefault();
      setCurrentTrackerPoint(analysisPointFromEvent(event));
      return;
    }
    if (!guideDrawing || event.pointerId !== guidePointerId || analysisMode !== 'guide') return;
    event.preventDefault();
    const point = analysisPointFromEvent(event);
    prepareGuideContext();
    if (guideTool === 'line') {
      guideCtx.putImageData(guideSnapshot, 0, 0);
      prepareGuideContext();
      guideCtx.beginPath();
      guideCtx.moveTo(guideStartPoint.x, guideStartPoint.y);
      guideCtx.lineTo(point.x, point.y);
      guideCtx.stroke();
    } else {
      guideCtx.lineTo(point.x, point.y);
      guideCtx.stroke();
      guideCtx.beginPath();
      guideCtx.moveTo(point.x, point.y);
    }
    guideLastPoint = point;
  });
  const finishAnalysisPointer = event => {
    if (event.pointerId === analysisTrackPointerId) {
      analysisTrackPointerId = null;
      queueAutosave();
      return;
    }
    if (!guideDrawing || event.pointerId !== guidePointerId) return;
    event.preventDefault();
    const point = analysisPointFromEvent(event);
    prepareGuideContext();
    if (guideTool === 'line') {
      guideCtx.putImageData(guideSnapshot, 0, 0);
      prepareGuideContext();
      guideCtx.beginPath();
      guideCtx.moveTo(guideStartPoint.x, guideStartPoint.y);
      guideCtx.lineTo(point.x, point.y);
      guideCtx.stroke();
    } else if (
      Math.hypot(point.x - guideStartPoint.x, point.y - guideStartPoint.y) < 2
    ) {
      guideCtx.beginPath();
      guideCtx.arc(point.x, point.y, guideSize / 2, 0, Math.PI * 2);
      guideCtx.fill();
    }
    guideDrawing = false;
    guidePointerId = null;
    guideStartPoint = null;
    guideLastPoint = null;
    guideSnapshot = null;
    saveGuideCanvas();
  };
  analysisOverlayCanvas.addEventListener('pointerup', finishAnalysisPointer);
  analysisOverlayCanvas.addEventListener('pointercancel', finishAnalysisPointer);

  const setPhaseAtCurrentFrame = type => {
    analysisPhases[type] = analysisFrame();
    renderPhaseBar();
    queueAutosave();
  };
  $('phaseAnticipation').addEventListener('click', () => setPhaseAtCurrentFrame('anticipation'));
  $('phaseAction').addEventListener('click', () => setPhaseAtCurrentFrame('action'));
  $('phaseFollow').addEventListener('click', () => setPhaseAtCurrentFrame('follow'));
  $('phaseEnd').addEventListener('click', () => setPhaseAtCurrentFrame('end'));
  $('clearPhases').addEventListener('click', () => {
    analysisPhases = { anticipation: null, action: null, follow: null, end: null };
    renderPhaseBar();
    queueAutosave();
  });
  $('phaseBar').addEventListener('click', event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    pauseAnalysis(false);
    setAnalysisTime((ratio * phaseTotalFrames()) / fps());
  });

  $('addKeyPose').addEventListener('click', addCurrentKeyPose);
  $('saveAnalysisSheet').addEventListener('click', saveAnalysisSheet);
  $('poseGrid').addEventListener('click', event => {
    const card = event.target.closest('.pose-card');
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!card || !action) return;
    const pose = keyPoses.find(item => item.id === card.dataset.id);
    if (!pose) return;
    if (action === 'seek') {
      pauseAnalysis(false);
      setAnalysisTime(pose.frame / fps());
    } else if (action === 'edit') {
      const note = prompt('重要ポーズのメモ', pose.note || '');
      if (note === null) return;
      pose.note = note.trim().slice(0, 120);
      renderKeyPoses();
      queueAutosave();
    } else if (action === 'delete') {
      keyPoses = keyPoses.filter(item => item.id !== pose.id);
      renderKeyPoses();
      renderPhaseBar();
      queueAutosave();
    }
  });

  $('back5').addEventListener('click', () => stepFrames(-5));
  $('back1').addEventListener('click', () => stepFrames(-1));
  $('next1').addEventListener('click', () => stepFrames(1));
  $('next5').addEventListener('click', () => stepFrames(5));
  $('go').addEventListener('click', () => seekToFrame($('gotoFrame').value));
  $('gotoFrame').addEventListener('keydown', event => {
    if (event.key === 'Enter') seekToFrame($('gotoFrame').value);
  });
  scrub.addEventListener('input', () => {
    if (video.duration) seekToTime((Number(scrub.value) / 1000) * video.duration);
  });

  fpsInput.addEventListener('change', () => {
    fpsInput.value = String(fps());
    currentLoadedFrame = -1;
    onionFrameCache.clear();
    updateHud(true);
    renderCompareUi();
    renderAnalysisUi();
    queueAutosave();
  });
  speedInput.addEventListener('change', () => {
    video.playbackRate = Number(speedInput.value) || 1;
    analysisVideo.playbackRate = Number(speedInput.value) || 1;
    queueAutosave();
  });
  $('setA').addEventListener('click', () => {
    A = video.currentTime || 0;
    setStatus(`A点 ${fmtTime(A)}`);
    queueAutosave();
  });
  $('setB').addEventListener('click', () => {
    B = video.currentTime || 0;
    setStatus(`B点 ${fmtTime(B)}`);
    queueAutosave();
  });
  $('loop').addEventListener('click', () => {
    if (!loopOn && (A === null || B === null || B <= A)) {
      setStatus('A点、B点の順に設定してください');
      return;
    }
    loopOn = !loopOn;
    $('loop').textContent = `ABループ ${loopOn ? 'ON' : 'OFF'}`;
    $('loop').classList.toggle('primary', loopOn);
    queueAutosave();
  });

  document.querySelectorAll('.tool').forEach(button => {
    button.addEventListener('click', () => {
      tool = button.dataset.tool;
      if (tool !== 'text') selectedTextId = null;
      document.querySelectorAll('.tool').forEach(item => item.classList.toggle('active', item === button));
      $('textControls').classList.toggle('hidden', tool !== 'text');
      renderCurrentFrame(frame());
      queueAutosave();
    });
  });
  document.querySelectorAll('.swatch').forEach(button => {
    button.addEventListener('click', () => {
      color = button.dataset.color;
      const item = selectedText();
      if (item && tool === 'text') {
        item.color = color;
        renderCurrentFrame(frame());
      }
      document.querySelectorAll('.swatch').forEach(item => item.classList.toggle('active', item === button));
      queueAutosave();
    });
  });
  $('brushSize').addEventListener('input', event => {
    brushSize = Number(event.target.value);
    $('brushValue').textContent = String(brushSize);
    queueAutosave();
  });
  $('textSize').addEventListener('input', event => {
    textSize = Number(event.target.value);
    $('textSizeValue').textContent = String(textSize);
    const item = selectedText();
    if (item) {
      item.size = clamp(textSize / drawCanvas.clientHeight, 0.025, 0.35);
      renderCurrentFrame(frame());
    }
    queueAutosave();
  });
  $('editText').addEventListener('click', () => {
    const item = selectedText();
    if (!item) {
      setStatus('先に編集する文字をタップしてください');
      return;
    }
    const value = prompt('文字を編集', item.text)?.trim();
    if (!value) return;
    item.text = value.slice(0, 120);
    renderCurrentFrame(frame());
    queueAutosave();
  });
  $('deleteText').addEventListener('click', () => {
    if (!selectedText()) {
      setStatus('先に削除する文字をタップしてください');
      return;
    }
    textItems = textItems.filter(item => item.id !== selectedTextId);
    selectedTextId = null;
    renderCurrentFrame(frame());
    queueAutosave();
  });

  $('clearDrawing').addEventListener('click', () => {
    const oldData = activeLayer().frames[frame()] || null;
    const oldTextCount = layerTexts(activeLayerId, frame()).length;
    if (!oldData && !oldTextCount) {
      setStatus('このレイヤーには書き込みがありません');
      return;
    }
    if (oldData) setActiveFrameData(null, true);
    textItems = textItems.filter(item => !(item.layerId === activeLayerId && item.frame === frame()));
    selectedTextId = null;
    queueAutosave();
    renderCurrentFrame(frame());
    setStatus(`${activeLayer().name}の${frame()}Fを消去しました`);
  });
  $('undo').addEventListener('click', () => {
    const key = historyKey();
    if (!history[key] || (historyIndex[key] ?? 0) <= 0) {
      setStatus('これ以上戻せません');
      return;
    }
    historyIndex[key] -= 1;
    const data = history[key][historyIndex[key]];
    const layer = activeLayer();
    if (data) layer.frames[frame()] = data;
    else delete layer.frames[frame()];
    renderCurrentFrame(frame());
    queueAutosave();
  });
  $('redo').addEventListener('click', () => {
    const key = historyKey();
    if (!history[key] || (historyIndex[key] ?? -1) >= history[key].length - 1) {
      setStatus('これ以上進めません');
      return;
    }
    historyIndex[key] += 1;
    const data = history[key][historyIndex[key]];
    const layer = activeLayer();
    if (data) layer.frames[frame()] = data;
    else delete layer.frames[frame()];
    renderCurrentFrame(frame());
    queueAutosave();
  });

  $('saveFrameImage').addEventListener('click', async () => {
    try {
      const output = await compositeCurrentFrame();
      output.toBlob(blob => {
        if (blob) downloadBlob(blob, `${safeFilename(projectName)}_${frame()}F.png`);
      }, 'image/png');
      setStatus('書き込み付き画像を保存しました');
    } catch (error) {
      setStatus(error.message);
    }
  });

  drawCanvas.addEventListener('pointerdown', event => {
    event.preventDefault();
    try {
      drawCanvas.setPointerCapture(event.pointerId);
    } catch (_) {}
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) beginDrawing(event);
    else if (pointers.size === 2) startGesture();
  });
  drawCanvas.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesturing) updateGesture();
    else continueDrawing(event);
  });
  const finishPointer = event => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    if (!gesturing) finishDrawing(event);
    pointers.delete(event.pointerId);
    if (gesturing && pointers.size < 2) {
      gesturing = false;
      gestureStart = null;
      queueAutosave();
    }
    if (!pointers.size) {
      drawing = false;
      drawingPointerId = null;
    }
  };
  drawCanvas.addEventListener('pointerup', finishPointer);
  drawCanvas.addEventListener('pointercancel', finishPointer);

  $('resetView').addEventListener('click', resetView);
  $('toggleAllLayers').addEventListener('click', () => {
    layersGloballyVisible = !layersGloballyVisible;
    applyLayerVisibility();
    queueAutosave();
  });
  $('addLayer').addEventListener('click', addLayer);
  $('layerList').addEventListener('click', event => {
    const item = event.target.closest('.layer-item');
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!item || !action) return;
    const index = layers.findIndex(layer => layer.id === item.dataset.id);
    if (index < 0) return;
    const layer = layers[index];
    if (action === 'select') {
      selectLayer(layer.id);
    } else if (action === 'visibility') {
      layer.visible = !layer.visible;
      renderLayerList();
      renderCurrentFrame(frame());
      queueAutosave();
    } else if (action === 'up' && index > 0) {
      [layers[index - 1], layers[index]] = [layers[index], layers[index - 1]];
      renderLayerList();
      renderCurrentFrame(frame());
      queueAutosave();
    } else if (action === 'down' && index < layers.length - 1) {
      [layers[index + 1], layers[index]] = [layers[index], layers[index + 1]];
      renderLayerList();
      renderCurrentFrame(frame());
      queueAutosave();
    } else if (action === 'rename') {
      const nextName = prompt('レイヤー名', layer.name)?.trim();
      if (nextName) {
        layer.name = nextName.slice(0, 40);
        renderLayerList();
        queueAutosave();
      }
    } else if (action === 'delete' && layers.length > 1) {
      const hasDrawing = Object.keys(layer.frames).length > 0 || textItems.some(item => item.layerId === layer.id);
      if (hasDrawing && !confirm(`「${layer.name}」と書き込みを削除しますか？`)) return;
      layers.splice(index, 1);
      textItems = textItems.filter(item => item.layerId !== layer.id);
      selectedTextId = null;
      if (activeLayerId === layer.id) activeLayerId = layers[Math.min(index, layers.length - 1)].id;
      renderLayerList();
      renderCurrentFrame(frame());
      queueAutosave();
    }
  });

  $('memoInput').addEventListener('input', event => {
    memoDraft = event.target.value;
    memoDraftFrame = frame();
    queueAutosave();
  });
  $('saveMemo').addEventListener('click', () => saveMemo(frame()));
  $('newGeneralMemo').addEventListener('click', () => saveMemo(null));
  $('memoSearch').addEventListener('input', renderMemos);
  $('noteList').addEventListener('click', event => {
    const item = event.target.closest('.note-item');
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!item || !action) return;
    const memo = memos.find(entry => entry.id === item.dataset.id);
    if (!memo) return;
    if (action === 'seek' && memo.frame !== null) {
      seekToFrame(memo.frame);
      document.querySelector('[data-tab="videoPanel"]').click();
    } else if (action === 'delete') {
      memos = memos.filter(entry => entry.id !== memo.id);
      renderMemos();
      queueAutosave();
    }
  });

  $('projectNameInput').addEventListener('input', event => {
    projectName = event.target.value.trimStart().slice(0, 80) || '無題のプロジェクト';
    queueAutosave();
  });
  $('projectNameInput').addEventListener('change', event => {
    event.target.value = projectName;
    saveProjectNow({ refreshList: true });
  });
  $('newProject').addEventListener('click', createNewProject);
  $('projectList').addEventListener('click', async event => {
    const item = event.target.closest('.project-item');
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!item || !action) return;
    const id = item.dataset.id;
    if (action === 'open' && id !== projectId) {
      await saveProjectNow();
      const record = await storeGet(PROJECT_STORE, id);
      if (record) {
        await restoreProject(record);
        await renderProjectList();
        setAutosaveStatus('saved', 'プロジェクトを開きました');
      }
    } else if (action === 'delete') {
      const record = await storeGet(PROJECT_STORE, id);
      if (!confirm(`「${record?.name || 'このプロジェクト'}」を端末から削除しますか？`)) return;
      await Promise.all([
        storeDelete(PROJECT_STORE, id),
        storeDelete(VIDEO_STORE, id).catch(() => {})
      ]);
      if (id === projectId) await createNewProject({ saveCurrent: false });
      else await renderProjectList();
    }
  });

  $('downloadProject').addEventListener('click', async () => {
    await saveProjectNow();
    const payload = {
      format: 'Animation Coach',
      version: '0.7',
      exportedAt: new Date().toISOString(),
      project: serializeProject()
    };
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `${safeFilename(projectName)}.animation-coach.json`
    );
  });
  $('importProject').addEventListener('change', async event => {
    const selected = event.target.files?.[0];
    if (!selected) return;
    try {
      const raw = JSON.parse(await selected.text());
      const migrated = migrateImportedProject(raw);
      await saveProjectNow();
      clearVideoSource();
      clearCompareOwnSource();
      applyProjectRecord(migrated);
      projectId = migrated.id;
      localStorage.setItem(LAST_PROJECT_KEY, projectId);
      await saveProjectNow({ refreshList: true });
      setAutosaveStatus('saved', 'プロジェクトを読み込み、自動保存しました');
      setStatus('旧バージョンのデータもレイヤーへ変換して読み込みました');
    } catch (error) {
      console.error(error);
      setStatus('プロジェクトJSONを読み込めませんでした');
    } finally {
      event.target.value = '';
    }
  });
  $('exportVideo').addEventListener('click', exportAnnotatedVideo);

  window.addEventListener('resize', () => {
    clearTimeout(window.__animationCoachResizeTimer);
    window.__animationCoachResizeTimer = setTimeout(() => {
      resizeCanvases();
      resizeAnalysisCanvases();
    }, 120);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProjectNow();
  });
  window.addEventListener('pagehide', () => {
    saveProjectNow();
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  resizeCanvases();
  renderLayerList();
  renderMemos();
  renderCompareUi();
  renderAnalysisUi();
  applyViewTransform();
  applyLayerVisibility();
  animationLoop();
  comparisonLoop();
  analysisLoop();
  initPersistence();
})();
