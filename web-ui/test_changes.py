import re

with open('index.html', 'r') as f:
    content = f.read()

# 1. 替换播放栏 HTML
old_player = '''<!-- 底部播放栏 --> <div class="glass-dark px-6 py-4 border-t border-white/10"> <div class="flex items-center gap-6"> <div class="flex items-center gap-4 w-72"> <div class="w-14 h-14 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-lg" :class="status.isPlaying ? 'cover-rotating' : 'cover-rotating paused'"> <span class="text-2xl">🎵</span> </div> <div class="min-w-0"> <div class="font-medium truncate">{{ currentTrack?.title || '未在播放' }}</div> <div class="text-sm text-gray-400 truncate">{{ currentTrack?.artist || '--' }}</div> </div> </div> <div class="flex-1 flex justify-center items-center gap-4"> <button @click="stop" class="glass w-10 h-10 rounded-full flex items-center justify-center hover:bg-white/10 transition-all"> <span class="text-xl">⏹</span> </button> </div> <div class="flex items-center gap-3 w-48"> <span class="text-xl">🔊</span> <input v-model.number="volume" type="range" min="0" max="100" class="flex-1 h-1 bg-white/20 rounded-full appearance-none cursor-pointer" @change="setVolume" style="accent-color: #a855f7;"> <span class="text-sm text-gray-400 w-10 text-right">{{ volume }}%</span> </div> </div> </div> </main>'''

new_player = '''<!-- 底部播放栏 --> <div class="glass-dark px-6 py-3 border-t border-white/10"> <div class="flex flex-col gap-2"> <div class="flex items-center gap-3"> <div class="w-12 h-12 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-lg flex-shrink-0" :class="status.isPlaying ? 'cover-rotating' : 'cover-rotating paused'"> <span class="text-xl">🎵</span> </div> <div class="min-w-0 flex-1"> <div class="font-medium truncate">{{ currentTrack?.title || '未在播放' }}</div> <div class="text-xs text-gray-400 truncate">{{ currentTrack?.artist || '--' }}</div> </div> <button @click="prevTrack" class="glass w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/10">⏮</button> <button @click="togglePlay" class="btn-gradient w-10 h-10 rounded-full flex items-center justify-center shadow-lg">{{ status.isPlaying ? '⏸' : '▶' }}</button> <button @click="nextTrack" class="glass w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/10">⏭</button> <div class="flex items-center gap-2 w-28"> <span @click="toggleMute" class="cursor-pointer">{{ volume === 0 ? '🔇' : '🔊' }}</span> <input v-model.number="volume" type="range" min="0" max="100" class="flex-1 h-1 bg-white/20 rounded-full" @change="setVolume" style="accent-color:#a855f7"> <span class="text-xs text-gray-400">{{ volume }}%</span> </div> </div> <div class="flex items-center gap-2 px-1"> <span class="text-xs text-gray-400 w-10 text-right">{{ formatTime(currentTime) }}</span> <div class="flex-1 h-1 bg-white/10 rounded-full cursor-pointer" @click="seekTo"><div class="h-full bg-gradient-to-r from-purple-500 to-pink-500 rounded-full" :style="{width:progress+'%'}"></div></div> <span class="text-xs text-gray-400 w-10">{{ formatTime(duration) }}</span> </div> </div> </div> </main>'''

if old_player in content:
    content = content.replace(old_player, new_player)
    print('Step 1: Player HTML replaced')
else:
    print('Step 1 FAILED: Player pattern not found')
    exit(1)

# 2. 添加 JavaScript 方法
old_setup = 'const { createApp, ref, computed, onMounted, onUnmounted, watch } = Vue;'
new_setup = '''const { createApp, ref, computed, onMounted, onUnmounted, watch } = Vue;
 
 // Player state
 let currentTime = ref(0);
 let duration = ref(0);
 let progress = computed(() => duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0);
 let playlist = ref([]);
 let playlistIndex = ref(-1);
 
 function formatTime(s) {
 if (!s || isNaN(s)) return '0:00';
 return Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0');
 }
 
 function togglePlay() {
 fetch('/api/control/' + (status.value.isPlaying ? 'pause' : 'resume'), {method:'POST'});
 }
 
 function prevTrack() {
 if (playlist.value.length === 0) return;
 playlistIndex.value = (playlistIndex.value - 1 + playlist.value.length) % playlist.value.length;
 const t = playlist.value[playlistIndex.value];
 if (t) { fetch('/api/local/play?file=' + encodeURIComponent(t.path)); currentTrack.value = {title:t.title, artist:t.artist}; }
 }
 
 function nextTrack() {
 if (playlist.value.length === 0) return;
 playlistIndex.value = (playlistIndex.value + 1) % playlist.value.length;
 const t = playlist.value[playlistIndex.value];
 if (t) { fetch('/api/local/play?file=' + encodeURIComponent(t.path)); currentTrack.value = {title:t.title, artist:t.artist}; }
 }
 
 function seekTo(e) {
 const r = e.currentTarget.getBoundingClientRect();
 currentTime.value = duration.value * (e.clientX - r.left) / r.width;
 }
 
 function toggleMute() {
 volume.value = volume.value > 0 ? 0 : 80;
 setVolume();
 }
'''

content = content.replace(old_setup, new_setup)
print('Step 2: JS methods added')

# 3. 在 return 中导出新变量和方法
old_return = 'return {'
new_return = '''return {
 // Player
 currentTime, duration, progress, playlist, playlistIndex,
 formatTime, togglePlay, prevTrack, nextTrack, seekTo, toggleMute,'''

content = content.replace(old_return, new_return)
print('Step 3: Return exports added')

with open('index.html', 'w') as f:
    f.write(content)

print('All changes applied successfully')
