import { defineStore } from 'pinia'
import {loginUserInfo} from "@/request/my.js";
import { session } from '@/auth/session.js'
import { isStaleSession } from '@/auth/session-core.mjs'

export const useUserStore = defineStore('user', {
    state: () => ({
        user: {},
        refreshList: 0,
    }),
    actions: {
        refreshUserList() {
            const lease = session.lease()
            return loginUserInfo().then(user => {
                lease.assertCurrent()
                this.refreshList ++
            }).catch(error => {
                if (!isStaleSession(error)) throw error
            })
        },
        refreshUserInfo() {
            const lease = session.lease()
            return loginUserInfo().then(user => {
                lease.assertCurrent()
                this.user = user
            }).catch(error => {
                if (!isStaleSession(error)) throw error
            })
        }
    }
})
