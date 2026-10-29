import {describe,it,expect,vi} from 'vitest'
import {mount} from '@vue/test-utils'
import {createPinia,setActivePinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import ElementPlus from 'element-plus'
import Aside from '@/layout/aside/index.vue'
import perm from '@/perm/perm.js'
import {useUserStore} from '@/store/user.js'
import {useSettingStore} from '@/store/setting.js'
const nav=vi.hoisted(()=>({push:vi.fn()}))
vi.mock('@/router/index.js',()=>({default:nav}))
vi.mock('vue-router',()=>({useRoute:()=>({name:'email',meta:{name:'email'}})}))
vi.mock('@/request/unified.js',()=>({request:vi.fn()}))
function render(perms){const pinia=createPinia();setActivePinia(pinia);useUserStore().user={email:'owner@test',permKeys:perms};useSettingStore().settings={title:'Cloud Mail'};return mount(Aside,{global:{plugins:[pinia,ElementPlus,createI18n({legacy:false,locale:'en',missingWarn:false,fallbackWarn:false,messages:{en:{}}})],directives:{perm}}})}
describe('original feature reachability',()=>{
  it('keeps every privileged original feature menu reachable for an administrator',async()=>{
    const w=render(['*'])
    const expected=['email','send','draft','star','setting','analysis','user','all-email','role','reg-key','sys-setting']
    const entries=w.findAll('.el-menu-item');expect(entries).toHaveLength(expected.length)
    for(let i=0;i<entries.length;i++){await entries[i].trigger('click');expect(nav.push).toHaveBeenLastCalledWith({name:expected[i]})}
    w.unmount()
  })
  it('does not expose privileged admin or send-only features to ordinary users without those permissions',()=>{
    const w=render([])
    expect(w.findAll('.el-menu-item').map(el=>el.text())).toEqual(['inbox','starred','settings'])
    expect(w.find('.compose-bar').exists()).toBe(false)
    w.unmount()
  })
})
