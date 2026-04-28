export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      boards: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      edges: {
        Row: {
          board_id: string
          created_at: string
          data: Json
          id: string
          relationship_label: string | null
          source_node_id: string
          target_node_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          board_id: string
          created_at?: string
          data?: Json
          id?: string
          relationship_label?: string | null
          source_node_id: string
          target_node_id: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          board_id?: string
          created_at?: string
          data?: Json
          id?: string
          relationship_label?: string | null
          source_node_id?: string
          target_node_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "edges_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edges_source_node_id_fkey"
            columns: ["source_node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edges_target_node_id_fkey"
            columns: ["target_node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      nodes: {
        Row: {
          board_id: string
          card_type: string
          created_at: string
          data: Json
          description: string | null
          id: string
          image_url: string | null
          link_type: string | null
          position_x: number
          position_y: number
          source: string | null
          text_content: string | null
          title: string | null
          updated_at: string
          url: string | null
          user_id: string
        }
        Insert: {
          board_id: string
          card_type: string
          created_at?: string
          data?: Json
          description?: string | null
          id?: string
          image_url?: string | null
          link_type?: string | null
          position_x?: number
          position_y?: number
          source?: string | null
          text_content?: string | null
          title?: string | null
          updated_at?: string
          url?: string | null
          user_id?: string
        }
        Update: {
          board_id?: string
          card_type?: string
          created_at?: string
          data?: Json
          description?: string | null
          id?: string
          image_url?: string | null
          link_type?: string | null
          position_x?: number
          position_y?: number
          source?: string | null
          text_content?: string | null
          title?: string | null
          updated_at?: string
          url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "nodes_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_sessions: {
        Row: {
          audio_url: string | null
          board_id: string
          connection_context: Json
          created_at: string
          ended_at: string | null
          id: string
          started_at: string | null
          transcript: Json | null
          user_id: string
        }
        Insert: {
          audio_url?: string | null
          board_id: string
          connection_context?: Json
          created_at?: string
          ended_at?: string | null
          id?: string
          started_at?: string | null
          transcript?: Json | null
          user_id: string
        }
        Update: {
          audio_url?: string | null
          board_id?: string
          connection_context?: Json
          created_at?: string
          ended_at?: string | null
          id?: string
          started_at?: string | null
          transcript?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_sessions_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
        ]
      }
      weave_embeddings: {
        Row: {
          archived_at: string | null
          board_id: string
          content_summary: string | null
          created_at: string
          embedding: string | null
          id: string
          metadata: Json | null
          node_id: string
          node_type: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          board_id: string
          content_summary?: string | null
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
          node_id: string
          node_type: string
          user_id?: string
        }
        Update: {
          archived_at?: string | null
          board_id?: string
          content_summary?: string | null
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
          node_id?: string
          node_type?: string
          user_id?: string
        }
        Relationships: []
      }
      weave_events: {
        Row: {
          board_id: string
          duration_ms: number | null
          event_type: string
          id: string
          metadata: Json | null
          session_id: string
          target_id: string | null
          timestamp: string
          user_id: string
        }
        Insert: {
          board_id: string
          duration_ms?: number | null
          event_type: string
          id?: string
          metadata?: Json | null
          session_id: string
          target_id?: string | null
          timestamp?: string
          user_id?: string
        }
        Update: {
          board_id?: string
          duration_ms?: number | null
          event_type?: string
          id?: string
          metadata?: Json | null
          session_id?: string
          target_id?: string | null
          timestamp?: string
          user_id?: string
        }
        Relationships: []
      }
      weave_profile_cluster_embeddings: {
        Row: {
          cluster_id: string
          embedding: string
          snapshot_id: string
          user_id: string | null
        }
        Insert: {
          cluster_id: string
          embedding: string
          snapshot_id: string
          user_id?: string | null
        }
        Update: {
          cluster_id?: string
          embedding?: string
          snapshot_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "weave_profile_cluster_embeddings_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "weave_profile_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      weave_profile_snapshots: {
        Row: {
          board_ids: string[]
          bridges: Json | null
          clusters: Json | null
          created_at: string
          event_count: number
          generation_metadata: Json | null
          id: string
          narrative: string | null
          node_count: number
          trigger_reason: string
          user_id: string | null
        }
        Insert: {
          board_ids: string[]
          bridges?: Json | null
          clusters?: Json | null
          created_at?: string
          event_count: number
          generation_metadata?: Json | null
          id?: string
          narrative?: string | null
          node_count: number
          trigger_reason?: string
          user_id?: string | null
        }
        Update: {
          board_ids?: string[]
          bridges?: Json | null
          clusters?: Json | null
          created_at?: string
          event_count?: number
          generation_metadata?: Json | null
          id?: string
          narrative?: string | null
          node_count?: number
          trigger_reason?: string
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      patch_node_data: {
        Args: {
          p_board_id: string
          p_client_id: string
          p_patch: Json
          p_user_id: string
        }
        Returns: undefined
      }
      replace_board_contents: {
        Args: { p_board_id: string; p_edges: Json; p_nodes: Json }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
