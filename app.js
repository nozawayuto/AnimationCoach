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
      version: '0.5',
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
        currentTime: compareCurrentTime
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
    compareMode = record.compare?.mode === 'overlay' ? 'overlay' : 'side';
    compareOpacity = clamp(Number(record.compare?.opacity) || 0.5, 0.1, 0.9);
    compareMarkers = Array.isArray(record.compare?.markers)
      ? record.compare.markers.map(marker => ({
        id: marker.id || uid(),
        frame: Math.max(0, Number(marker.frame) || 0),
        type: ['fix', 'check', 'ok'].includes(marker.type) ? marker.type : 'check'
      }))
      : [];
    compareCurrentTime = Math.max(0, Number(record.compare?.currentTime) || 0);
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
    revokeVideoUrl();
    video.removeAttribute('src');
    compareRefVideo.removeAttribute('src');
    video.load();
    compareRefVideo.load();
    empty.classList.remove('hidden');
    $('compareRefEmpty').classList.remove('hidden');
    scrub.value = '0';
    currentLoadedFrame = -1;
    renderCurrentFrame(0);
  }

  function loadVideoBlob(blob, name = '') {
    return new Promise((resolve, reject) => {
      video.pause();
      revokeVideoUrl();
      objectUrl = URL.createObjectURL(blob);
      video.src = objectUrl;
      compareRefVideo.src = objectUrl;
      videoName = name || videoName;
      empty.classList.add('hidden');
      $('compareRefEmpty').classList.add('hidden');
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
    renderLayerList();
    renderMemos();
    renderCurrentFrame(frame());
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

  function compareDuration() {
    const durations = [compareRefVideo.duration, compareOwnVideo.duration]
      .filter(value => Number.isFinite(value) && value > 0);
    if (!durations.length) return 0;
    return durations.length === 2 ? Math.min(...durations) : durations[0];
  }

  function compareMasterVideo() {
    if (compareRefVideo.src && compareRefVideo.readyState >= 1) return compareRefVideo;
    if (compareOwnVideo.src && compareOwnVideo.readyState >= 1) return compareOwnVideo;
    return null;
  }

  function setCompareTime(time, autosave = true) {
    const duration = compareDuration();
    compareCurrentTime = clamp(Number(time) || 0, 0, Math.max(0, duration ? duration - 0.001 : Number(time) || 0));
    [compareRefVideo, compareOwnVideo].forEach(item => {
      if (!item.src || item.readyState < 1) return;
      item.currentTime = clamp(compareCurrentTime, 0, Math.max(0, item.duration - 0.001));
    });
    updateCompareHud();
    if (autosave) queueAutosave(900);
  }

  function updateCompareHud() {
    const currentFrame = Math.max(0, Math.round(compareCurrentTime * fps()));
    $('compareFrameHud').textContent = `F ${currentFrame}`;
    $('compareTimeHud').textContent = fmtTime(compareCurrentTime);
    const duration = compareDuration();
    $('compareScrub').value = duration
      ? String(Math.round((compareCurrentTime / duration) * 1000))
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
    const duration = compareDuration();
    if (duration && compareCurrentTime >= duration - 0.02) setCompareTime(0, false);
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
    const duration = compareDuration();
    const maxFrame = duration
      ? Math.max(1, Math.round(duration * fps()))
      : Math.max(1, ...compareMarkers.map(marker => marker.frame));
    [...compareMarkers]
      .sort((a, b) => a.frame - b.frame)
      .forEach(marker => {
        const dot = document.createElement('button');
        dot.className = `marker-dot ${marker.type}`;
        const percent = clamp((marker.frame / maxFrame) * 100, 1.5, 98.5);
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
        label.textContent = markerLabel(marker.type);
        const remove = document.createElement('button');
        remove.className = 'icon-btn';
        remove.dataset.action = 'delete';
        remove.textContent = '×';
        item.append(kind, frameButton, label, remove);
        list.append(item);
      });
  }

  function addCompareMarker(type) {
    const targetFrame = Math.max(0, Math.round(compareCurrentTime * fps()));
    const existing = compareMarkers.find(marker => marker.frame === targetFrame);
    if (existing) existing.type = type;
    else compareMarkers.push({ id: uid(), frame: targetFrame, type });
    renderMarkers();
    queueAutosave();
  }

  function renderCompareUi() {
    const overlay = compareMode === 'overlay';
    $('compareVideos').classList.toggle('overlay', overlay);
    $('compareMode').textContent = overlay ? '左右に並べる' : '半透明で重ねる';
    $('compareVideos').style.setProperty('--compare-opacity', String(compareOpacity));
    $('compareOpacity').value = String(Math.round(compareOpacity * 100));
    $('compareOpacityValue').textContent = String(Math.round(compareOpacity * 100));
    updateCompareHud();
    renderMarkers();
  }

  function comparisonLoop() {
    if (comparePlaying) {
      const master = compareMasterVideo();
      if (master) {
        compareCurrentTime = master.currentTime || 0;
        const follower = master === compareRefVideo ? compareOwnVideo : compareRefVideo;
        if (follower.src && follower.readyState >= 1 && Math.abs(follower.currentTime - compareCurrentTime) > 0.055) {
          follower.currentTime = clamp(compareCurrentTime, 0, Math.max(0, follower.duration - 0.001));
        }
        const duration = compareDuration();
        if ((duration && compareCurrentTime >= duration - 0.015) || master.ended) pauseComparison();
        updateCompareHud();
      }
    }
    requestAnimationFrame(comparisonLoop);
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
      document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('active', panel.id === button.dataset.tab));
      if (button.dataset.tab === 'videoPanel') {
        requestAnimationFrame(() => resizeCanvases());
      } else if (button.dataset.tab === 'comparePanel') {
        video.pause();
        renderCompareUi();
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
    setCompareTime((Number(event.target.value) / 1000) * compareDuration());
  });
  $('compareMode').addEventListener('click', () => {
    compareMode = compareMode === 'overlay' ? 'side' : 'overlay';
    renderCompareUi();
    queueAutosave();
  });
  $('compareOpacity').addEventListener('input', event => {
    compareOpacity = clamp(Number(event.target.value) / 100, 0.1, 0.9);
    renderCompareUi();
    queueAutosave();
  });
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
    else if (action === 'delete') {
      compareMarkers = compareMarkers.filter(entry => entry.id !== marker.id);
      renderMarkers();
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
    updateHud(true);
    queueAutosave();
  });
  speedInput.addEventListener('change', () => {
    video.playbackRate = Number(speedInput.value) || 1;
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
      version: '0.5',
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
    window.__animationCoachResizeTimer = setTimeout(resizeCanvases, 120);
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
  applyViewTransform();
  applyLayerVisibility();
  animationLoop();
  comparisonLoop();
  initPersistence();
})();
