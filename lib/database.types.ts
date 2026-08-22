// meet schema 的 Database 类型（手写，依据 supabase/migrations/0001+0002 的 DDL）。
// 不用 generate_typescript_types 整库生成：共享库会把其他项目的 schema 全部拖进来。
// DDL 变更时同步维护本文件。接入点：lib/supabase.ts createClient<Database, 'meet'>。

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type RoomStatus = 'active' | 'ended' | 'disabled'
export type MediaProviderKind = 'livekit' | 'agora'
export type ParticipantRole = 'host' | 'guest'

export interface Database {
  meet: {
    Tables: {
      rooms: {
        Row: {
          id: string
          owner_id: string
          room_code: string
          title: string
          password_hash: string | null
          media_room_name: string
          media_provider: MediaProviderKind
          max_participants: number
          require_login: boolean
          scheduled_at: string | null
          expires_at: string | null
          status: RoomStatus
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          room_code: string
          title?: string
          password_hash?: string | null
          media_room_name: string
          media_provider?: MediaProviderKind
          max_participants?: number
          require_login?: boolean
          scheduled_at?: string | null
          expires_at?: string | null
          status?: RoomStatus
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          owner_id?: string
          room_code?: string
          title?: string
          password_hash?: string | null
          media_room_name?: string
          media_provider?: MediaProviderKind
          max_participants?: number
          require_login?: boolean
          scheduled_at?: string | null
          expires_at?: string | null
          status?: RoomStatus
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      meetings: {
        Row: {
          id: string
          room_id: string
          started_at: string
          ended_at: string | null
          peak_participants: number
        }
        Insert: {
          id?: string
          room_id: string
          started_at?: string
          ended_at?: string | null
          peak_participants?: number
        }
        Update: {
          id?: string
          room_id?: string
          started_at?: string
          ended_at?: string | null
          peak_participants?: number
        }
        Relationships: []
      }
      participants: {
        Row: {
          id: string
          meeting_id: string
          user_id: string | null
          media_identity: string
          display_name: string
          role: ParticipantRole
          joined_at: string
          left_at: string | null
        }
        Insert: {
          id?: string
          meeting_id: string
          user_id?: string | null
          media_identity: string
          display_name: string
          role?: ParticipantRole
          joined_at?: string
          left_at?: string | null
        }
        Update: {
          id?: string
          meeting_id?: string
          user_id?: string | null
          media_identity?: string
          display_name?: string
          role?: ParticipantRole
          joined_at?: string
          left_at?: string | null
        }
        Relationships: []
      }
      meeting_sessions: {
        Row: {
          id: string
          participant_id: string
          event: string
          detail: Json
          at: string
        }
        Insert: {
          id?: string
          participant_id: string
          event: string
          detail?: Json
          at?: string
        }
        Update: {
          id?: string
          participant_id?: string
          event?: string
          detail?: Json
          at?: string
        }
        Relationships: []
      }
      join_attempts: {
        Row: {
          room_code: string
          ip: string
          window_start: string
          attempts: number
        }
        Insert: {
          room_code: string
          ip: string
          window_start?: string
          attempts?: number
        }
        Update: {
          room_code?: string
          ip?: string
          window_start?: string
          attempts?: number
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      register_join_attempt: {
        Args: { p_room_code: string; p_ip: string; p_max?: number; p_window?: string }
        Returns: boolean
      }
      reset_join_attempts: {
        Args: { p_room_code: string; p_ip: string }
        Returns: undefined
      }
      prune_join_attempts: {
        Args: Record<string, never>
        Returns: undefined
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
