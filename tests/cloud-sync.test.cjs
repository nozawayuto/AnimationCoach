const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeElement() {
  const listeners = new Map();
  return {
    classList: { toggle() {} },
    disabled: false,
    textContent: '',
    value: '',
    addEventListener(type, listener) { listeners.set(type, listener); },
    querySelector() { return { textContent: '' }; },
    trigger(type) { return listeners.get(type)?.(); }
  };
}

async function run() {
  const user = { id: 'user-1', email: 'coach@example.com' };
  const project = { id: 'project-1', name: 'Walk cycle', updatedAt: 200 };
  const projects = new Map([[project.id, project]]);
  const videos = new Map([[project.id, {
    projectId: project.id,
    name: 'walk.mp4',
    type: 'video/mp4',
    size: 3,
    updatedAt: 200,
    blob: { size: 3, type: 'video/mp4' },
    versions: []
  }]]);
  const rows = new Map();
  const objects = new Map();
  const uploads = [];
  const removals = [];
  const windowListeners = new Map();
  const elements = new Map();
  const storageValues = new Map();
  const navigator = { onLine: true };

  function element(id) {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  }

  function queryBuilder(kind) {
    const filters = [];
    const matchingRows = () => [...rows.values()].filter(row => filters.every(([key, value]) => row[key] === value));
    const result = () => kind === 'delete'
      ? (() => {
          matchingRows().forEach(row => rows.delete(row.id));
          return { data: null, error: null };
        })()
      : { data: matchingRows(), error: null };
    return {
      eq(key, value) { filters.push([key, value]); return this; },
      async maybeSingle() { return { data: matchingRows()[0] || null, error: null }; },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
    };
  }

  const client = {
    auth: {
      onAuthStateChange() {},
      async getSession() { return { data: { session: { user, access_token: 'test-token' } }, error: null }; },
      async signInWithPassword() { return { error: null }; },
      async signUp() { return { data: { session: { user } }, error: null }; },
      async signOut() { return { error: null }; }
    },
    from() {
      return {
        select() { return queryBuilder('select'); },
        async upsert(row) { rows.set(row.id, row); return { error: null }; },
        delete() { return queryBuilder('delete'); }
      };
    },
    storage: {
      from() {
        return {
          async upload(objectPath, blob) {
            uploads.push(objectPath);
            objects.set(objectPath, blob);
            return { error: null };
          },
          async download(objectPath) { return { data: objects.get(objectPath), error: null }; },
          async remove(paths) {
            removals.push(...paths);
            paths.forEach(objectPath => objects.delete(objectPath));
            return { error: null };
          }
        };
      }
    }
  };

  const window = {
    ANIMATION_COACH_CLOUD_CONFIG: {
      url: 'https://example.supabase.co',
      anonKey: 'publishable-test-key',
      projectTable: 'animation_projects',
      mediaBucket: 'animation-coach-media'
    },
    supabase: { createClient: () => client },
    AnimationCoachStorage: {
      async getAllProjects() { return [...projects.values()]; },
      async getProject(id) { return projects.get(id) || null; },
      async putProject(record) { projects.set(record.id, record); },
      async getVideo(id) { return videos.get(id) || null; },
      async putVideo(record) { videos.set(record.projectId, record); },
      currentProjectId() { return project.id; },
      async renderProjectList() {},
      async restoreProjectById() {}
    },
    addEventListener(type, listener) { windowListeners.set(type, listener); }
  };

  const context = vm.createContext({
    window,
    document: { getElementById: element },
    navigator,
    localStorage: {
      getItem(key) { return storageValues.get(key) || null; },
      setItem(key, value) { storageValues.set(key, String(value)); }
    },
    location: { origin: 'http://localhost', pathname: '/' },
    URL,
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'cloud-sync.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'cloud-sync.js' });
  const cloud = window.AnimationCoachCloud;

  await cloud.init();
  assert.equal(uploads.length, 1, '初回同期では動画を1回アップロードする');
  assert.equal(rows.get(project.id).media_manifest.main.size, 3);

  cloud.onVideoChanged(project.id);
  await cloud.syncNow();
  assert.equal(uploads.length, 1, '変更のない動画は再アップロードしない');

  videos.get(project.id).updatedAt = 300;
  videos.get(project.id).blob = { size: 4, type: 'video/mp4' };
  videos.get(project.id).size = 4;
  cloud.onVideoChanged(project.id);
  await cloud.syncNow();
  assert.equal(uploads.length, 2, '変更した動画だけを再アップロードする');

  navigator.onLine = false;
  videos.get(project.id).updatedAt = 400;
  videos.get(project.id).blob = { size: 5, type: 'video/mp4' };
  videos.get(project.id).size = 5;
  cloud.onVideoChanged(project.id);
  assert.equal(uploads.length, 2, 'オフライン中はアップロードしない');
  navigator.onLine = true;
  windowListeners.get('online')();
  await cloud.syncNow();
  assert.equal(uploads.length, 3, '通信復帰後に保留動画をアップロードする');

  navigator.onLine = false;
  await cloud.deleteProject(project.id);
  projects.delete(project.id);
  navigator.onLine = true;
  windowListeners.get('online')();
  await cloud.syncNow();
  assert.equal(rows.has(project.id), false, 'オフライン削除したプロジェクトをクラウドから削除する');
  assert.equal(objects.size, 0, '削除時にクラウド動画も削除する');
  assert.ok(removals.length >= 1);

  console.log('cloud-sync tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
