(() => {
  'use strict';

  const config = window.ANIMATION_COACH_CLOUD_CONFIG || {};
  const $ = id => document.getElementById(id);
  const state = {
    client: null,
    user: null,
    initialized: false,
    busy: false,
    syncTimer: null,
    syncChain: Promise.resolve(),
    manifests: new Map(),
    pendingProjectIds: new Set(),
    pendingDeletes: new Set()
  };

  const bridge = () => window.AnimationCoachStorage;
  const tableName = config.projectTable || 'animation_projects';
  const bucketName = config.mediaBucket || 'animation-coach-media';

  function isOnline() {
    return navigator.onLine !== false;
  }

  function requireOnline() {
    if (!isOnline()) {
      const error = new Error('OFFLINE');
      error.code = 'OFFLINE';
      throw error;
    }
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
  }

  function cloudSummary(manifest = {}) {
    const items = [manifest.main, manifest.compare, ...(manifest.versions || [])].filter(Boolean);
    return {
      count: items.length,
      bytes: items.reduce((total, item) => total + Math.max(0, Number(item.size) || 0), 0)
    };
  }

  function lastSyncKey() {
    return state.user ? `animation-coach-cloud-last-sync:${state.user.id}` : '';
  }

  function pendingDeleteKey() {
    return state.user ? `animation-coach-cloud-pending-deletes:${state.user.id}` : '';
  }

  function loadPendingDeletes() {
    state.pendingDeletes.clear();
    const key = pendingDeleteKey();
    if (!key) return;
    try {
      const values = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(values)) values.filter(Boolean).forEach(id => state.pendingDeletes.add(String(id)));
    } catch (error) {
      console.warn('クラウド削除待ち情報を読み込めませんでした', error);
    }
  }

  function savePendingDeletes() {
    const key = pendingDeleteKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify([...state.pendingDeletes]));
  }

  function markSyncComplete() {
    const key = lastSyncKey();
    if (key) localStorage.setItem(key, String(Date.now()));
  }

  function renderCloudSummary(projectId = bridge()?.currentProjectId?.()) {
    const summaryBox = $('cloudSummary');
    const lastSyncBox = $('cloudLastSync');
    if (!summaryBox || !lastSyncBox) return;
    if (!state.user) {
      summaryBox.textContent = '';
      lastSyncBox.textContent = '';
      return;
    }
    const manifest = state.manifests.get(projectId) || {};
    const summary = cloudSummary(manifest);
    summaryBox.textContent = summary.count
      ? `クラウド保存：動画 ${summary.count}本・${formatBytes(summary.bytes)}`
      : 'このプロジェクトの動画はまだクラウド未保存です';
    const lastSync = Number(localStorage.getItem(lastSyncKey()) || 0);
    lastSyncBox.textContent = lastSync
      ? `最終同期：${new Date(lastSync).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : '最終同期：まだありません';
  }

  function setCloudState(mode, label, message = '') {
    const box = $('cloudState');
    if (box) {
      box.classList.toggle('online', mode === 'online');
      box.classList.toggle('syncing', mode === 'syncing');
      box.classList.toggle('error', mode === 'error');
      const text = box.querySelector('span:last-child');
      if (text) text.textContent = label;
    }
    if ($('cloudMessage')) $('cloudMessage').textContent = message;
  }

  function setProgress(value, visible = true) {
    const progress = $('cloudProgress');
    if (!progress) return;
    progress.classList.toggle('hidden', !visible);
    progress.value = Math.max(0, Math.min(1, Number(value) || 0));
  }

  function setBusy(busy) {
    state.busy = busy;
    ['cloudSignIn', 'cloudSignUp', 'cloudSaveCurrent', 'cloudSyncNow', 'cloudSignOut'].forEach(id => {
      if ($(id)) $(id).disabled = busy;
    });
  }

  function renderAuth() {
    const signedIn = Boolean(state.user);
    $('cloudSignedOut')?.classList.toggle('hidden', signedIn);
    $('cloudSignedIn')?.classList.toggle('hidden', !signedIn);
    if ($('cloudAccount')) $('cloudAccount').textContent = signedIn ? `ログイン中：${state.user.email || 'アカウント'}` : '';
    renderCloudSummary();
    if (signedIn && isOnline()) setCloudState('online', '接続済み');
    else if (signedIn) setCloudState('', 'オフライン', '端末内には保存済みです。通信復帰後にクラウド同期します');
    else setCloudState('', '未接続');
  }

  function friendlyError(error) {
    const message = String(error?.message || error || '不明なエラー');
    if (/invalid login credentials/i.test(message)) return 'メールアドレスまたはパスワードが違います';
    if (/email not confirmed/i.test(message)) return '確認メール内のリンクを開いてからログインしてください';
    if (/already registered/i.test(message)) return 'このメールアドレスは登録済みです。ログインしてください';
    if (/OFFLINE|failed to fetch|network/i.test(message)) return '現在オフラインです。端末内に保存し、通信復帰後に再同期します';
    if (/maximum allowed size|payload too large|entity too large|413/i.test(message)) return '動画がクラウドの保存上限を超えています。短くするか圧縮してください';
    return message;
  }

  function pathSegment(value) {
    return encodeURIComponent(String(value || '').replaceAll('/', '-'));
  }

  function mediaBase(projectId) {
    return `${state.user.id}/${pathSegment(projectId)}`;
  }

  function remoteTimestamp(row) {
    return Math.max(0, Number(row?.client_updated_at) || Number(row?.project_data?.updatedAt) || 0);
  }

  function mediaNeedsUpload(videoRecord, manifest = {}) {
    if (!videoRecord) return false;
    if (videoRecord.blob && Number(videoRecord.updatedAt || 0) > Number(manifest.main?.updatedAt || 0)) return true;
    if (videoRecord.compareBlob && Number(videoRecord.compareUpdatedAt || 0) > Number(manifest.compare?.updatedAt || 0)) return true;
    const remoteVersions = new Map((manifest.versions || []).map(item => [item.id, item]));
    const localVersions = Array.isArray(videoRecord.versions) ? videoRecord.versions : [];
    if (localVersions.length !== remoteVersions.size) return true;
    return localVersions.some(item => !remoteVersions.has(item.id)
      || Number(item.createdAt || 0) > Number(remoteVersions.get(item.id)?.updatedAt || 0));
  }

  async function upsertProject(record, manifest = state.manifests.get(record.id) || {}) {
    if (!state.user || !record?.id) return;
    requireOnline();
    const row = {
      user_id: state.user.id,
      id: record.id,
      name: record.name || '無題のプロジェクト',
      project_data: record,
      media_manifest: manifest,
      client_updated_at: Number(record.updatedAt) || Date.now(),
      updated_at: new Date().toISOString()
    };
    const { error } = await state.client.from(tableName).upsert(row, { onConflict: 'user_id,id' });
    if (error) throw error;
    state.manifests.set(record.id, manifest);
  }

  async function uploadBlob(path, blob, type = '', onProgress = null) {
    requireOnline();
    if (blob.size > 6 * 1024 * 1024) {
      if (!window.tus?.Upload) throw new Error('大きな動画のアップロード機能を読み込めませんでした');
      const { data, error: sessionError } = await state.client.auth.getSession();
      if (sessionError) throw sessionError;
      if (!data.session?.access_token) throw new Error('ログインの有効期限が切れました。再度ログインしてください');
      const projectRef = new URL(config.url).hostname.split('.')[0];
      await new Promise((resolve, reject) => {
        const upload = new window.tus.Upload(blob, {
          endpoint: `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`,
          retryDelays: [0, 3000, 5000, 10000, 20000],
          headers: {
            authorization: `Bearer ${data.session.access_token}`,
            apikey: config.anonKey,
            'x-upsert': 'true'
          },
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true,
          chunkSize: 6 * 1024 * 1024,
          metadata: {
            bucketName,
            objectName: path,
            contentType: type || blob.type || 'application/octet-stream',
            cacheControl: '3600'
          },
          onError: reject,
          onProgress: (bytesUploaded, bytesTotal) => onProgress?.(bytesUploaded / Math.max(1, bytesTotal)),
          onSuccess: resolve
        });
        upload.findPreviousUploads()
          .then(previousUploads => {
            if (previousUploads.length) upload.resumeFromPreviousUpload(previousUploads[0]);
            upload.start();
          })
          .catch(reject);
      });
      return;
    }
    const { error } = await state.client.storage.from(bucketName).upload(path, blob, {
      cacheControl: '3600',
      contentType: type || blob.type || 'application/octet-stream',
      upsert: true
    });
    if (error) throw error;
    onProgress?.(1);
  }

  async function uploadProjectMedia(projectId, { showProgress = false } = {}) {
    if (!state.user) return;
    const storage = bridge();
    const videoRecord = await storage.getVideo(projectId);
    const oldManifest = state.manifests.get(projectId) || {};
    if (!videoRecord) {
      const record = await storage.getProject(projectId);
      if (record) await upsertProject(record, oldManifest);
      renderCloudSummary(projectId);
      return oldManifest;
    }

    const entries = [];
    const base = mediaBase(projectId);
    if (videoRecord.blob) {
      entries.push({
        kind: 'main',
        path: `${base}/main`,
        blob: videoRecord.blob,
        name: videoRecord.name || '動画',
        type: videoRecord.type || videoRecord.blob.type || '',
        size: videoRecord.size || videoRecord.blob.size || 0,
        updatedAt: Number(videoRecord.updatedAt) || Date.now()
      });
    }
    if (videoRecord.compareBlob) {
      entries.push({
        kind: 'compare',
        path: `${base}/compare`,
        blob: videoRecord.compareBlob,
        name: videoRecord.compareName || '修正後動画',
        type: videoRecord.compareType || videoRecord.compareBlob.type || '',
        size: videoRecord.compareSize || videoRecord.compareBlob.size || 0,
        updatedAt: Number(videoRecord.compareUpdatedAt) || Date.now()
      });
    }
    (videoRecord.versions || []).forEach(version => {
      if (!version?.blob || !version.id) return;
      entries.push({
        kind: 'version',
        id: version.id,
        path: `${base}/versions/${pathSegment(version.id)}`,
        blob: version.blob,
        label: version.label || '保存版',
        name: version.name || '修正後動画',
        type: version.type || version.blob.type || '',
        size: version.size || version.blob.size || 0,
        createdAt: Number(version.createdAt) || Date.now(),
        updatedAt: Number(version.createdAt) || Date.now()
      });
    });

    if (!entries.length && Object.keys(oldManifest).length) {
      const record = await storage.getProject(projectId);
      if (record) await upsertProject(record, oldManifest);
      renderCloudSummary(projectId);
      return oldManifest;
    }

    const manifest = { versions: [] };
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const previous = entry.kind === 'version'
        ? (oldManifest.versions || []).find(item => item.id === entry.id)
        : oldManifest[entry.kind];
      const isChanged = !previous?.path
        || Number(entry.updatedAt || 0) > Number(previous.updatedAt || 0)
        || Number(entry.size || 0) !== Number(previous.size || 0);
      if (isChanged) {
        await uploadBlob(entry.path, entry.blob, entry.type, entryProgress => {
          if (showProgress) setProgress((index + entryProgress) / Math.max(1, entries.length), true);
        });
      }
      const metadata = { ...entry };
      delete metadata.blob;
      delete metadata.kind;
      if (entry.kind === 'version') manifest.versions.push(metadata);
      else manifest[entry.kind] = metadata;
      if (showProgress) setProgress((index + 1) / Math.max(1, entries.length), true);
    }

    const nextPaths = new Set([
      manifest.main?.path,
      manifest.compare?.path,
      ...manifest.versions.map(item => item.path)
    ].filter(Boolean));
    const removedPaths = [
      oldManifest.main?.path,
      oldManifest.compare?.path,
      ...(oldManifest.versions || []).map(item => item.path)
    ].filter(path => path && !nextPaths.has(path));
    if (removedPaths.length) {
      const { error } = await state.client.storage.from(bucketName).remove(removedPaths);
      if (error) throw error;
    }

    state.manifests.set(projectId, manifest);
    const record = await storage.getProject(projectId);
    if (record) await upsertProject(record, manifest);
    renderCloudSummary(projectId);
    return manifest;
  }

  async function downloadBlob(path) {
    requireOnline();
    const { data, error } = await state.client.storage.from(bucketName).download(path);
    if (error) throw error;
    return data;
  }

  async function downloadProjectMedia(projectId, manifest = state.manifests.get(projectId) || {}) {
    if (!state.user || (!manifest.main && !manifest.compare && !(manifest.versions || []).length)) return false;
    const storage = bridge();
    const local = await storage.getVideo(projectId) || { projectId };
    let changed = false;
    const downloads = [];

    if (manifest.main && (!local.blob || Number(manifest.main.updatedAt || 0) > Number(local.updatedAt || 0))) {
      downloads.push(async () => {
        local.blob = await downloadBlob(manifest.main.path);
        local.name = manifest.main.name;
        local.type = manifest.main.type;
        local.size = manifest.main.size;
        local.updatedAt = manifest.main.updatedAt;
        changed = true;
      });
    }
    if (manifest.compare && (!local.compareBlob || Number(manifest.compare.updatedAt || 0) > Number(local.compareUpdatedAt || 0))) {
      downloads.push(async () => {
        local.compareBlob = await downloadBlob(manifest.compare.path);
        local.compareName = manifest.compare.name;
        local.compareType = manifest.compare.type;
        local.compareSize = manifest.compare.size;
        local.compareUpdatedAt = manifest.compare.updatedAt;
        changed = true;
      });
    }

    const localVersions = new Map((local.versions || []).map(item => [item.id, item]));
    for (const remoteVersion of manifest.versions || []) {
      const existing = localVersions.get(remoteVersion.id);
      if (existing?.blob && Number(existing.createdAt || 0) >= Number(remoteVersion.updatedAt || 0)) continue;
      downloads.push(async () => {
        localVersions.set(remoteVersion.id, {
          id: remoteVersion.id,
          label: remoteVersion.label,
          name: remoteVersion.name,
          type: remoteVersion.type,
          size: remoteVersion.size,
          createdAt: remoteVersion.createdAt,
          blob: await downloadBlob(remoteVersion.path)
        });
        changed = true;
      });
    }

    for (let index = 0; index < downloads.length; index += 1) {
      await downloads[index]();
      setProgress((index + 1) / Math.max(1, downloads.length), true);
    }
    const remoteIds = new Set((manifest.versions || []).map(item => item.id));
    if ((local.versions || []).some(item => !remoteIds.has(item.id))) changed = true;
    local.versions = [...localVersions.values()]
      .filter(item => remoteIds.has(item.id))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (changed) await storage.putVideo(local);
    return changed;
  }

  async function fetchRemoteRows() {
    requireOnline();
    const { data, error } = await state.client
      .from(tableName)
      .select('id,name,project_data,media_manifest,client_updated_at,updated_at');
    if (error) throw error;
    return data || [];
  }

  async function fetchRemoteProject(projectId) {
    requireOnline();
    const { data, error } = await state.client
      .from(tableName)
      .select('id,name,project_data,media_manifest,client_updated_at,updated_at')
      .eq('id', projectId)
      .maybeSingle();
    if (error) throw error;
    if (data) state.manifests.set(data.id, data.media_manifest || {});
    return data || null;
  }

  async function removeRemoteProject(projectId) {
    requireOnline();
    let manifest = state.manifests.get(projectId);
    if (!manifest) manifest = (await fetchRemoteProject(projectId))?.media_manifest || {};
    const paths = [
      manifest.main?.path,
      manifest.compare?.path,
      ...(manifest.versions || []).map(item => item.path)
    ].filter(Boolean);
    if (paths.length) {
      const { error: storageError } = await state.client.storage.from(bucketName).remove(paths);
      if (storageError) throw storageError;
    }
    const { error } = await state.client
      .from(tableName)
      .delete()
      .eq('user_id', state.user.id)
      .eq('id', projectId);
    if (error) throw error;
    state.manifests.delete(projectId);
  }

  async function flushPendingDeletes() {
    for (const projectId of [...state.pendingDeletes]) {
      await removeRemoteProject(projectId);
      state.pendingDeletes.delete(projectId);
      savePendingDeletes();
    }
  }

  async function performFullSync() {
    if (!state.user) return;
    requireOnline();
    const storage = bridge();
    setBusy(true);
    setCloudState('syncing', '同期中', 'クラウドと照合しています…');
    setProgress(0, true);
    try {
      await flushPendingDeletes();
      const remoteRows = await fetchRemoteRows();
      remoteRows.forEach(row => state.manifests.set(row.id, row.media_manifest || {}));
      const remoteById = new Map(remoteRows.map(row => [row.id, row]));
      const localProjects = await storage.getAllProjects();
      const localById = new Map(localProjects.map(record => [record.id, record]));
      const ids = [...new Set([...remoteById.keys(), ...localById.keys()])];
      let pulledCurrent = false;

      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        const remote = remoteById.get(id);
        const local = localById.get(id);
        if (remote && (!local || remoteTimestamp(remote) > Number(local.updatedAt || 0))) {
          await storage.putProject(remote.project_data);
          state.pendingProjectIds.delete(id);
          if (id === storage.currentProjectId()) pulledCurrent = true;
        } else if (local) {
          await upsertProject(local, remote?.media_manifest || {});
          const videoRecord = await storage.getVideo(id);
          if (mediaNeedsUpload(videoRecord, remote?.media_manifest || {})) {
            await uploadProjectMedia(id);
          }
          state.pendingProjectIds.delete(id);
        }
        setProgress((index + 1) / Math.max(1, ids.length), true);
      }

      const currentId = storage.currentProjectId();
      if (currentId && state.manifests.has(currentId)) {
        await downloadProjectMedia(currentId, state.manifests.get(currentId));
        if (pulledCurrent) await storage.restoreProjectById(currentId, true);
      }
      await storage.renderProjectList();
      markSyncComplete();
      renderCloudSummary(currentId);
      setCloudState('online', '同期済み', `同期完了 ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`);
      setProgress(1, false);
    } catch (error) {
      console.error(error);
      setCloudState('error', '同期エラー', friendlyError(error));
      setProgress(0, false);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function runExclusive(task) {
    state.syncChain = state.syncChain.catch(() => {}).then(task);
    return state.syncChain;
  }

  async function signIn() {
    const email = $('cloudEmail')?.value.trim();
    const password = $('cloudPassword')?.value || '';
    if (!email || !password) {
      setCloudState('error', '入力待ち', 'メールアドレスとパスワードを入力してください');
      return;
    }
    setBusy(true);
    setCloudState('syncing', 'ログイン中', 'アカウントを確認しています…');
    try {
      const { error } = await state.client.auth.signInWithPassword({ email, password });
      if (error) setCloudState('error', 'ログイン失敗', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function signUp() {
    const email = $('cloudEmail')?.value.trim();
    const password = $('cloudPassword')?.value || '';
    if (!email || password.length < 6) {
      setCloudState('error', '入力待ち', 'メールアドレスと6文字以上のパスワードを入力してください');
      return;
    }
    setBusy(true);
    setCloudState('syncing', '登録中', 'アカウントを作成しています…');
    try {
      const redirectTo = `${location.origin}${location.pathname}`;
      const { data, error } = await state.client.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectTo }
      });
      if (error) {
        setCloudState('error', '登録失敗', friendlyError(error));
        return;
      }
      if (!data.session) setCloudState('', 'メール確認待ち', '確認メールを開くと登録が完了します');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const { error } = await state.client.auth.signOut();
      if (error) setCloudState('error', 'ログアウト失敗', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrentProject() {
    if (!state.user) return;
    requireOnline();
    const storage = bridge();
    const projectId = storage.currentProjectId();
    const record = projectId ? await storage.getProject(projectId) : null;
    if (!projectId || !record) {
      setCloudState('online', '接続済み', '保存するプロジェクトがありません');
      return;
    }
    setBusy(true);
    setCloudState('syncing', 'クラウド保存中', 'このプロジェクトの変更と動画を保存しています…');
    setProgress(0, true);
    try {
      await uploadProjectMedia(projectId, { showProgress: true });
      state.pendingProjectIds.delete(projectId);
      markSyncComplete();
      renderCloudSummary(projectId);
      setProgress(1, false);
      setCloudState('online', '同期済み', 'このプロジェクトをクラウドへ保存しました');
    } finally {
      setBusy(false);
    }
  }

  async function init() {
    if (state.initialized) return;
    state.initialized = true;
    $('cloudSignIn')?.addEventListener('click', () => signIn().catch(error => setCloudState('error', 'ログイン失敗', friendlyError(error))));
    $('cloudSignUp')?.addEventListener('click', () => signUp().catch(error => setCloudState('error', '登録失敗', friendlyError(error))));
    $('cloudSignOut')?.addEventListener('click', () => signOut().catch(error => setCloudState('error', 'ログアウト失敗', friendlyError(error))));
    $('cloudSaveCurrent')?.addEventListener('click', () => runExclusive(saveCurrentProject).catch(error => {
      setProgress(0, false);
      setCloudState('error', '保存エラー', friendlyError(error));
    }));
    $('cloudSyncNow')?.addEventListener('click', () => runExclusive(performFullSync).catch(() => {}));
    window.addEventListener('offline', () => {
      if (state.user) setCloudState('', 'オフライン', '端末内には保存済みです。通信復帰後にクラウド同期します');
    });
    window.addEventListener('online', () => {
      if (!state.user) return;
      setCloudState('syncing', '再接続中', '通信が戻りました。保留中の変更を同期しています…');
      runExclusive(performFullSync).catch(() => {});
    });

    if (!config.url || !config.anonKey) {
      setCloudState('error', '設定待ち', 'クラウド接続設定がまだ完了していません');
      setBusy(true);
      return;
    }
    if (!window.supabase?.createClient) {
      setCloudState('error', '読込エラー', 'クラウド機能を読み込めませんでした');
      setBusy(true);
      return;
    }

    state.client = window.supabase.createClient(config.url, config.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    state.client.auth.onAuthStateChange((event, session) => {
      const previousUserId = state.user?.id || '';
      state.user = session?.user || null;
      if ((state.user?.id || '') !== previousUserId) {
        state.manifests.clear();
        state.pendingProjectIds.clear();
        loadPendingDeletes();
      }
      renderAuth();
      if (event !== 'INITIAL_SESSION' && state.user && state.user.id !== previousUserId && isOnline()) {
        setTimeout(() => runExclusive(performFullSync).catch(() => {}), 0);
      }
    });
    const { data, error } = await state.client.auth.getSession();
    if (error) throw error;
    state.user = data.session?.user || null;
    loadPendingDeletes();
    renderAuth();
    if (state.user && isOnline()) await runExclusive(performFullSync);
  }

  function onLocalSave(record) {
    if (!state.user || !record?.id) return;
    state.pendingProjectIds.add(record.id);
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => {
      if (!isOnline()) {
        setCloudState('', '同期保留', '端末内に保存しました。通信復帰後にクラウドへ保存します');
        return;
      }
      runExclusive(async () => {
        setCloudState('syncing', '同期中', '変更をクラウドへ保存しています…');
        const latestRecord = await bridge().getProject(record.id) || record;
        await upsertProject(latestRecord);
        state.pendingProjectIds.delete(record.id);
        markSyncComplete();
        renderCloudSummary(record.id);
        setCloudState('online', '同期済み', '変更をクラウドへ保存しました');
      }).catch(error => setCloudState('error', '同期エラー', friendlyError(error)));
    }, 1800);
  }

  function onVideoChanged(projectId) {
    if (!state.user || !projectId) return;
    state.pendingProjectIds.add(projectId);
    if (!isOnline()) {
      setCloudState('', '動画同期保留', '動画は端末内に保存済みです。通信復帰後にアップロードします');
      return;
    }
    runExclusive(async () => {
      setBusy(true);
      setCloudState('syncing', '動画を同期中', '動画をクラウドへアップロードしています…');
      setProgress(0, true);
      await uploadProjectMedia(projectId, { showProgress: true });
      state.pendingProjectIds.delete(projectId);
      markSyncComplete();
      renderCloudSummary(projectId);
      setProgress(1, false);
      setCloudState('online', '同期済み', '動画をクラウドへ保存しました');
      setBusy(false);
    }).catch(error => {
      setBusy(false);
      setProgress(0, false);
      setCloudState('error', '動画同期エラー', friendlyError(error));
    });
  }

  function prepareProject(projectId) {
    if (!state.user || !projectId) return Promise.resolve(false);
    if (!isOnline()) {
      setCloudState('', 'オフライン', 'この端末に保存済みの動画を開きます');
      return Promise.resolve(false);
    }
    return runExclusive(async () => {
      setCloudState('syncing', '動画を取得中', 'この端末へ動画を読み込んでいます…');
      if (!state.manifests.has(projectId)) await fetchRemoteProject(projectId);
      const changed = await downloadProjectMedia(projectId);
      renderCloudSummary(projectId);
      setProgress(1, false);
      setCloudState('online', '同期済み', changed ? '動画をこの端末へ保存しました' : '最新の状態です');
      return changed;
    }).catch(error => {
      setProgress(0, false);
      setCloudState('error', '取得エラー', friendlyError(error));
      return false;
    });
  }

  function deleteProject(projectId) {
    if (!state.user || !projectId) return Promise.resolve();
    state.pendingDeletes.add(projectId);
    savePendingDeletes();
    if (!isOnline()) {
      setCloudState('', '削除を保留中', '通信復帰後にクラウドからも削除します');
      return Promise.resolve();
    }
    return runExclusive(async () => {
      await removeRemoteProject(projectId);
      state.pendingDeletes.delete(projectId);
      savePendingDeletes();
      renderCloudSummary();
      setCloudState('online', '同期済み', 'クラウドからも削除しました');
    }).catch(error => setCloudState('error', '削除エラー', friendlyError(error)));
  }

  window.AnimationCoachCloud = {
    init,
    onLocalSave,
    onVideoChanged,
    prepareProject,
    deleteProject,
    onProjectChanged: projectId => renderCloudSummary(projectId),
    syncNow: () => runExclusive(performFullSync),
    isSignedIn: () => Boolean(state.user)
  };
})();
