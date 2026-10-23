export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      activity_log: {
        Row: {
          action: string;
          actor_user_id: string | null;
          at: string;
          broker_id: string;
          created_at: string;
          entity_id: string;
          entity_type: string;
          id: string;
          payload: NonNullable<Json>;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          actor_user_id?: string | null;
          at?: string;
          broker_id: string;
          created_at?: string;
          entity_id: string;
          entity_type: string;
          id?: string;
          payload?: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          action?: string;
          actor_user_id?: string | null;
          at?: string;
          broker_id?: string;
          created_at?: string;
          entity_id?: string;
          entity_type?: string;
          id?: string;
          payload?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "activity_log_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
        ];
      };
      attachments: {
        Row: {
          broker_id: string;
          created_at: string;
          filename: string;
          id: string;
          mime: string;
          owner_id: string;
          owner_type: string;
          sha256: string;
          size_bytes: number;
          storage_path: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          created_at?: string;
          filename: string;
          id?: string;
          mime: string;
          owner_id: string;
          owner_type: string;
          sha256: string;
          size_bytes: number;
          storage_path: string;
          updated_at?: string;
        };
        Update: {
          broker_id?: string;
          created_at?: string;
          filename?: string;
          id?: string;
          mime?: string;
          owner_id?: string;
          owner_type?: string;
          sha256?: string;
          size_bytes?: number;
          storage_path?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "attachments_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
        ];
      };
      broker_members: {
        Row: {
          broker_id: string;
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["member_role"];
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["member_role"];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          broker_id?: string;
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["member_role"];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "broker_members_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
        ];
      };
      brokers: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      catalog_aliases: {
        Row: {
          alias: string;
          broker_id: string | null;
          catalog_item_id: string;
          created_at: string;
          id: string;
          source: Database["public"]["Enums"]["alias_source"];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          alias: string;
          broker_id?: string | null;
          catalog_item_id: string;
          created_at?: string;
          id?: string;
          source: Database["public"]["Enums"]["alias_source"];
          updated_at?: string;
        };
        Update: {
          alias?: string;
          broker_id?: string | null;
          catalog_item_id?: string;
          created_at?: string;
          id?: string;
          source?: Database["public"]["Enums"]["alias_source"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "catalog_aliases_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalog_aliases_catalog_item_id_fkey";
            columns: ["catalog_item_id"];
            isOneToOne: false;
            referencedRelation: "catalog_items";
            referencedColumns: ["id"];
          },
        ];
      };
      catalog_items: {
        Row: {
          category: Database["public"]["Enums"]["material_category"];
          created_at: string;
          default_grade: string | null;
          designation: string;
          dims: NonNullable<Json>;
          id: string;
          updated_at: string;
          weight_per_ft: number | null;
        };
        ComputedFields: never;
        Insert: {
          category: Database["public"]["Enums"]["material_category"];
          created_at?: string;
          default_grade?: string | null;
          designation: string;
          dims?: NonNullable<Json>;
          id?: string;
          updated_at?: string;
          weight_per_ft?: number | null;
        };
        Update: {
          category?: Database["public"]["Enums"]["material_category"];
          created_at?: string;
          default_grade?: string | null;
          designation?: string;
          dims?: NonNullable<Json>;
          id?: string;
          updated_at?: string;
          weight_per_ft?: number | null;
        };
        Relationships: [];
      };
      customer_contacts: {
        Row: {
          broker_id: string;
          created_at: string;
          customer_id: string;
          email: string;
          id: string;
          name: string;
          phone: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          created_at?: string;
          customer_id: string;
          email: string;
          id?: string;
          name: string;
          phone?: string;
          updated_at?: string;
        };
        Update: {
          broker_id?: string;
          created_at?: string;
          customer_id?: string;
          email?: string;
          id?: string;
          name?: string;
          phone?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "customer_contacts_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "customer_contacts_customer_id_broker_id_fkey";
            columns: ["customer_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      customers: {
        Row: {
          broker_id: string;
          created_at: string;
          email_domain: string;
          id: string;
          name: string;
          notes: string;
          short_name: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          created_at?: string;
          email_domain?: string;
          id?: string;
          name: string;
          notes?: string;
          short_name?: string;
          updated_at?: string;
        };
        Update: {
          broker_id?: string;
          created_at?: string;
          email_domain?: string;
          id?: string;
          name?: string;
          notes?: string;
          short_name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "customers_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          body_html: string | null;
          body_text: string;
          broker_id: string;
          cc_emails: string[];
          created_at: string;
          direction: Database["public"]["Enums"]["message_direction"];
          from_email: string;
          id: string;
          in_reply_to: string | null;
          matched_by: Database["public"]["Enums"]["matched_by"];
          provider_message_id: string | null;
          raw_attachment_id: string | null;
          received_at: string;
          references: string[];
          request_id: string | null;
          rfq_id: string | null;
          subject: string;
          to_emails: string[];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          body_html?: string | null;
          body_text: string;
          broker_id: string;
          cc_emails?: string[];
          created_at?: string;
          direction: Database["public"]["Enums"]["message_direction"];
          from_email: string;
          id?: string;
          in_reply_to?: string | null;
          matched_by?: Database["public"]["Enums"]["matched_by"];
          provider_message_id?: string | null;
          raw_attachment_id?: string | null;
          received_at?: string;
          references?: string[];
          request_id?: string | null;
          rfq_id?: string | null;
          subject?: string;
          to_emails?: string[];
          updated_at?: string;
        };
        Update: {
          body_html?: string | null;
          body_text?: string;
          broker_id?: string;
          cc_emails?: string[];
          created_at?: string;
          direction?: Database["public"]["Enums"]["message_direction"];
          from_email?: string;
          id?: string;
          in_reply_to?: string | null;
          matched_by?: Database["public"]["Enums"]["matched_by"];
          provider_message_id?: string | null;
          raw_attachment_id?: string | null;
          received_at?: string;
          references?: string[];
          request_id?: string | null;
          rfq_id?: string | null;
          subject?: string;
          to_emails?: string[];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_raw_attachment_id_broker_id_fkey";
            columns: ["raw_attachment_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "attachments";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "messages_request_id_broker_id_fkey";
            columns: ["request_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "requests";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "messages_rfq_id_broker_id_fkey";
            columns: ["rfq_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "rfqs";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      offer_lines: {
        Row: {
          alternate_types: Database["public"]["Enums"]["alternate_type"][];
          availability: Database["public"]["Enums"]["availability"];
          available_qty: number | null;
          broker_id: string;
          confidence: number;
          created_at: string;
          delivery_estimate_text: string | null;
          extended_price: number | null;
          flags: string[];
          id: string;
          is_exact_match: boolean;
          offer_id: string;
          offered_catalog_item_id: string | null;
          offered_desc: string;
          price_basis: Database["public"]["Enums"]["price_basis"] | null;
          ready_date: string | null;
          request_line_id: string;
          source_span: NonNullable<Json>;
          unit: Database["public"]["Enums"]["line_unit"] | null;
          unit_price: number | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          alternate_types?: Database["public"]["Enums"]["alternate_type"][];
          availability?: Database["public"]["Enums"]["availability"];
          available_qty?: number | null;
          broker_id: string;
          confidence: number;
          created_at?: string;
          delivery_estimate_text?: string | null;
          extended_price?: number | null;
          flags?: string[];
          id?: string;
          is_exact_match?: boolean;
          offer_id: string;
          offered_catalog_item_id?: string | null;
          offered_desc: string;
          price_basis?: Database["public"]["Enums"]["price_basis"] | null;
          ready_date?: string | null;
          request_line_id: string;
          source_span?: NonNullable<Json>;
          unit?: Database["public"]["Enums"]["line_unit"] | null;
          unit_price?: number | null;
          updated_at?: string;
        };
        Update: {
          alternate_types?: Database["public"]["Enums"]["alternate_type"][];
          availability?: Database["public"]["Enums"]["availability"];
          available_qty?: number | null;
          broker_id?: string;
          confidence?: number;
          created_at?: string;
          delivery_estimate_text?: string | null;
          extended_price?: number | null;
          flags?: string[];
          id?: string;
          is_exact_match?: boolean;
          offer_id?: string;
          offered_catalog_item_id?: string | null;
          offered_desc?: string;
          price_basis?: Database["public"]["Enums"]["price_basis"] | null;
          ready_date?: string | null;
          request_line_id?: string;
          source_span?: NonNullable<Json>;
          unit?: Database["public"]["Enums"]["line_unit"] | null;
          unit_price?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "offer_lines_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "offer_lines_offer_id_broker_id_fkey";
            columns: ["offer_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "vendor_offers";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "offer_lines_offered_catalog_item_id_fkey";
            columns: ["offered_catalog_item_id"];
            isOneToOne: false;
            referencedRelation: "catalog_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "offer_lines_request_line_id_broker_id_fkey";
            columns: ["request_line_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "request_lines";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      purchase_lines: {
        Row: {
          broker_id: string;
          created_at: string;
          id: string;
          purchase_id: string;
          selection_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          created_at?: string;
          id?: string;
          purchase_id: string;
          selection_id: string;
          updated_at?: string;
        };
        Update: {
          broker_id?: string;
          created_at?: string;
          id?: string;
          purchase_id?: string;
          selection_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "purchase_lines_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchase_lines_purchase_id_broker_id_fkey";
            columns: ["purchase_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "purchases";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "purchase_lines_selection_id_broker_id_fkey";
            columns: ["selection_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "sourcing_selections";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      purchases: {
        Row: {
          branch_id: string;
          broker_id: string;
          confirmed_at: string;
          created_at: string;
          id: string;
          notes: string;
          po_number: string | null;
          request_id: string;
          total_freight: number | null;
          total_material: number | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          branch_id: string;
          broker_id: string;
          confirmed_at?: string;
          created_at?: string;
          id?: string;
          notes?: string;
          po_number?: string | null;
          request_id: string;
          total_freight?: number | null;
          total_material?: number | null;
          updated_at?: string;
        };
        Update: {
          branch_id?: string;
          broker_id?: string;
          confirmed_at?: string;
          created_at?: string;
          id?: string;
          notes?: string;
          po_number?: string | null;
          request_id?: string;
          total_freight?: number | null;
          total_material?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "purchases_branch_id_broker_id_fkey";
            columns: ["branch_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "vendor_branches";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "purchases_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "purchases_request_id_broker_id_fkey";
            columns: ["request_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "requests";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      request_lines: {
        Row: {
          broker_id: string;
          catalog_item_id: string | null;
          category: Database["public"]["Enums"]["material_category"] | null;
          confidence: number;
          created_at: string;
          cut_to_length: boolean;
          delivery_notes: string | null;
          description: string;
          dims: NonNullable<Json>;
          flags: string[];
          grade_spec: string | null;
          id: string;
          length_ft: number | null;
          length_text: string | null;
          line_no: number;
          qty: number | null;
          raw_text: string;
          request_id: string;
          source_span: NonNullable<Json>;
          status: Database["public"]["Enums"]["request_line_status"];
          unit: Database["public"]["Enums"]["line_unit"] | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          catalog_item_id?: string | null;
          category?: Database["public"]["Enums"]["material_category"] | null;
          confidence: number;
          created_at?: string;
          cut_to_length?: boolean;
          delivery_notes?: string | null;
          description: string;
          dims?: NonNullable<Json>;
          flags?: string[];
          grade_spec?: string | null;
          id?: string;
          length_ft?: number | null;
          length_text?: string | null;
          line_no: number;
          qty?: number | null;
          raw_text: string;
          request_id: string;
          source_span?: NonNullable<Json>;
          status?: Database["public"]["Enums"]["request_line_status"];
          unit?: Database["public"]["Enums"]["line_unit"] | null;
          updated_at?: string;
        };
        Update: {
          broker_id?: string;
          catalog_item_id?: string | null;
          category?: Database["public"]["Enums"]["material_category"] | null;
          confidence?: number;
          created_at?: string;
          cut_to_length?: boolean;
          delivery_notes?: string | null;
          description?: string;
          dims?: NonNullable<Json>;
          flags?: string[];
          grade_spec?: string | null;
          id?: string;
          length_ft?: number | null;
          length_text?: string | null;
          line_no?: number;
          qty?: number | null;
          raw_text?: string;
          request_id?: string;
          source_span?: NonNullable<Json>;
          status?: Database["public"]["Enums"]["request_line_status"];
          unit?: Database["public"]["Enums"]["line_unit"] | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "request_lines_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "request_lines_catalog_item_id_fkey";
            columns: ["catalog_item_id"];
            isOneToOne: false;
            referencedRelation: "catalog_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "request_lines_request_id_broker_id_fkey";
            columns: ["request_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "requests";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      requests: {
        Row: {
          broker_id: string;
          created_at: string;
          customer_id: string | null;
          delivery_requirements: string;
          id: string;
          notes: string;
          parent_request_id: string | null;
          received_at: string;
          revision: number;
          source_message_id: string | null;
          source_text: string;
          source_type: Database["public"]["Enums"]["request_source_type"];
          status: Database["public"]["Enums"]["request_status"];
          subject: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          created_at?: string;
          customer_id?: string | null;
          delivery_requirements?: string;
          id?: string;
          notes?: string;
          parent_request_id?: string | null;
          received_at?: string;
          revision?: number;
          source_message_id?: string | null;
          source_text: string;
          source_type: Database["public"]["Enums"]["request_source_type"];
          status?: Database["public"]["Enums"]["request_status"];
          subject?: string;
          updated_at?: string;
        };
        Update: {
          broker_id?: string;
          created_at?: string;
          customer_id?: string | null;
          delivery_requirements?: string;
          id?: string;
          notes?: string;
          parent_request_id?: string | null;
          received_at?: string;
          revision?: number;
          source_message_id?: string | null;
          source_text?: string;
          source_type?: Database["public"]["Enums"]["request_source_type"];
          status?: Database["public"]["Enums"]["request_status"];
          subject?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "requests_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "requests_customer_id_broker_id_fkey";
            columns: ["customer_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "requests_parent_request_id_broker_id_fkey";
            columns: ["parent_request_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "requests";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      rfq_lines: {
        Row: {
          broker_id: string;
          created_at: string;
          id: string;
          note: string | null;
          request_line_id: string;
          rfq_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          request_line_id: string;
          rfq_id: string;
          updated_at?: string;
        };
        Update: {
          broker_id?: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          request_line_id?: string;
          rfq_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "rfq_lines_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rfq_lines_request_line_id_broker_id_fkey";
            columns: ["request_line_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "request_lines";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "rfq_lines_rfq_id_broker_id_fkey";
            columns: ["rfq_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "rfqs";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      rfqs: {
        Row: {
          body_text: string;
          branch_id: string;
          broker_id: string;
          cc_emails: string[];
          created_at: string;
          id: string;
          idempotency_key: string;
          include_customer_name: boolean;
          last_error: string | null;
          provider_message_id: string | null;
          request_id: string;
          revision: number;
          sent_at: string | null;
          status: Database["public"]["Enums"]["rfq_status"];
          subject: string;
          to_emails: string[];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          body_text: string;
          branch_id: string;
          broker_id: string;
          cc_emails?: string[];
          created_at?: string;
          id?: string;
          idempotency_key: string;
          include_customer_name?: boolean;
          last_error?: string | null;
          provider_message_id?: string | null;
          request_id: string;
          revision?: number;
          sent_at?: string | null;
          status?: Database["public"]["Enums"]["rfq_status"];
          subject: string;
          to_emails?: string[];
          updated_at?: string;
        };
        Update: {
          body_text?: string;
          branch_id?: string;
          broker_id?: string;
          cc_emails?: string[];
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          include_customer_name?: boolean;
          last_error?: string | null;
          provider_message_id?: string | null;
          request_id?: string;
          revision?: number;
          sent_at?: string | null;
          status?: Database["public"]["Enums"]["rfq_status"];
          subject?: string;
          to_emails?: string[];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "rfqs_branch_id_broker_id_fkey";
            columns: ["branch_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "vendor_branches";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "rfqs_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rfqs_request_id_broker_id_fkey";
            columns: ["request_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "requests";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      sourcing_selections: {
        Row: {
          broker_id: string;
          created_at: string;
          id: string;
          note: string | null;
          offer_line_id: string;
          qty: number;
          request_line_id: string;
          selected_at: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          offer_line_id: string;
          qty: number;
          request_line_id: string;
          selected_at?: string;
          updated_at?: string;
        };
        Update: {
          broker_id?: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          offer_line_id?: string;
          qty?: number;
          request_line_id?: string;
          selected_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sourcing_selections_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sourcing_selections_offer_line_id_broker_id_fkey";
            columns: ["offer_line_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "offer_lines";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "sourcing_selections_request_line_id_broker_id_fkey";
            columns: ["request_line_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "request_lines";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      vendor_branches: {
        Row: {
          broker_id: string;
          city: string;
          created_at: string;
          early_pay_days: number | null;
          early_pay_pct: number | null;
          freight_default: Database["public"]["Enums"]["freight_default"];
          id: string;
          name: string;
          notes: string;
          payment_terms: string | null;
          preferred: boolean;
          region: string | null;
          state: string;
          updated_at: string;
          vendor_id: string;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          city: string;
          created_at?: string;
          early_pay_days?: number | null;
          early_pay_pct?: number | null;
          freight_default?: Database["public"]["Enums"]["freight_default"];
          id?: string;
          name: string;
          notes?: string;
          payment_terms?: string | null;
          preferred?: boolean;
          region?: string | null;
          state: string;
          updated_at?: string;
          vendor_id: string;
        };
        Update: {
          broker_id?: string;
          city?: string;
          created_at?: string;
          early_pay_days?: number | null;
          early_pay_pct?: number | null;
          freight_default?: Database["public"]["Enums"]["freight_default"];
          id?: string;
          name?: string;
          notes?: string;
          payment_terms?: string | null;
          preferred?: boolean;
          region?: string | null;
          state?: string;
          updated_at?: string;
          vendor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_branches_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_branches_vendor_id_broker_id_fkey";
            columns: ["vendor_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      vendor_capabilities: {
        Row: {
          branch_id: string;
          broker_id: string;
          category: Database["public"]["Enums"]["material_category"];
          created_at: string;
          id: string;
          notes: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          branch_id: string;
          broker_id: string;
          category: Database["public"]["Enums"]["material_category"];
          created_at?: string;
          id?: string;
          notes?: string | null;
          updated_at?: string;
        };
        Update: {
          branch_id?: string;
          broker_id?: string;
          category?: Database["public"]["Enums"]["material_category"];
          created_at?: string;
          id?: string;
          notes?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_capabilities_branch_id_broker_id_fkey";
            columns: ["branch_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "vendor_branches";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "vendor_capabilities_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
        ];
      };
      vendor_contacts: {
        Row: {
          branch_id: string;
          broker_id: string;
          created_at: string;
          email: string;
          id: string;
          is_primary: boolean;
          name: string;
          notes: string;
          phone: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          branch_id: string;
          broker_id: string;
          created_at?: string;
          email: string;
          id?: string;
          is_primary?: boolean;
          name: string;
          notes?: string;
          phone?: string | null;
          updated_at?: string;
        };
        Update: {
          branch_id?: string;
          broker_id?: string;
          created_at?: string;
          email?: string;
          id?: string;
          is_primary?: boolean;
          name?: string;
          notes?: string;
          phone?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_contacts_branch_id_broker_id_fkey";
            columns: ["branch_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "vendor_branches";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "vendor_contacts_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
        ];
      };
      vendor_offers: {
        Row: {
          attachment_id: string | null;
          branch_id: string;
          broker_id: string;
          confidence: number;
          created_at: string;
          early_pay_days: number | null;
          early_pay_pct: number | null;
          freight_amount: number | null;
          freight_basis: Database["public"]["Enums"]["freight_basis"];
          id: string;
          message_id: string | null;
          notes: string;
          payment_terms: string | null;
          quote_expires_at: string | null;
          received_at: string;
          rfq_id: string;
          source: Database["public"]["Enums"]["offer_source"];
          status: Database["public"]["Enums"]["offer_status"];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attachment_id?: string | null;
          branch_id: string;
          broker_id: string;
          confidence: number;
          created_at?: string;
          early_pay_days?: number | null;
          early_pay_pct?: number | null;
          freight_amount?: number | null;
          freight_basis?: Database["public"]["Enums"]["freight_basis"];
          id?: string;
          message_id?: string | null;
          notes?: string;
          payment_terms?: string | null;
          quote_expires_at?: string | null;
          received_at?: string;
          rfq_id: string;
          source: Database["public"]["Enums"]["offer_source"];
          status?: Database["public"]["Enums"]["offer_status"];
          updated_at?: string;
        };
        Update: {
          attachment_id?: string | null;
          branch_id?: string;
          broker_id?: string;
          confidence?: number;
          created_at?: string;
          early_pay_days?: number | null;
          early_pay_pct?: number | null;
          freight_amount?: number | null;
          freight_basis?: Database["public"]["Enums"]["freight_basis"];
          id?: string;
          message_id?: string | null;
          notes?: string;
          payment_terms?: string | null;
          quote_expires_at?: string | null;
          received_at?: string;
          rfq_id?: string;
          source?: Database["public"]["Enums"]["offer_source"];
          status?: Database["public"]["Enums"]["offer_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_offers_attachment_id_broker_id_fkey";
            columns: ["attachment_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "attachments";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "vendor_offers_branch_id_broker_id_fkey";
            columns: ["branch_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "vendor_branches";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "vendor_offers_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_offers_message_id_broker_id_fkey";
            columns: ["message_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id", "broker_id"];
          },
          {
            foreignKeyName: "vendor_offers_rfq_id_broker_id_fkey";
            columns: ["rfq_id", "broker_id"];
            isOneToOne: false;
            referencedRelation: "rfqs";
            referencedColumns: ["id", "broker_id"];
          },
        ];
      };
      vendors: {
        Row: {
          broker_id: string;
          created_at: string;
          id: string;
          name: string;
          notes: string;
          updated_at: string;
          vendor_type: Database["public"]["Enums"]["vendor_type"];
          website: string | null;
        };
        ComputedFields: never;
        Insert: {
          broker_id: string;
          created_at?: string;
          id?: string;
          name: string;
          notes?: string;
          updated_at?: string;
          vendor_type: Database["public"]["Enums"]["vendor_type"];
          website?: string | null;
        };
        Update: {
          broker_id?: string;
          created_at?: string;
          id?: string;
          name?: string;
          notes?: string;
          updated_at?: string;
          vendor_type?: Database["public"]["Enums"]["vendor_type"];
          website?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vendors_broker_id_fkey";
            columns: ["broker_id"];
            isOneToOne: false;
            referencedRelation: "brokers";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      is_broker_member: { Args: { target_broker_id: string }; Returns: boolean };
    };
    Enums: {
      alias_source: "seed" | "learned";
      alternate_type: "grade" | "dimension" | "wall" | "length";
      availability: "stock" | "rolling" | "unknown";
      freight_basis: "included" | "separate" | "unknown";
      freight_default: "quoted" | "arranged" | "fob" | "unknown";
      line_unit: "pcs" | "ft" | "in" | "lbs" | "cwt" | "tons" | "sqft";
      matched_by: "thread" | "manual" | "ai" | "none";
      material_category:
        | "hss_square"
        | "hss_rectangular"
        | "hss_round"
        | "pipe"
        | "w_beam"
        | "s_beam"
        | "channel"
        | "angle"
        | "flat_bar"
        | "round_bar"
        | "square_bar"
        | "plate"
        | "sheet"
        | "rebar";
      member_role: "owner" | "admin" | "member";
      message_direction: "in" | "out";
      offer_source: "email" | "pdf" | "phone" | "text" | "manual";
      offer_status: "parsed" | "reviewed" | "declined";
      price_basis: "per_cwt" | "per_lb" | "per_ft" | "per_pc" | "per_ton" | "per_sqft";
      request_line_status: "parsed" | "confirmed" | "custom" | "removed";
      request_source_type: "paste" | "eml" | "manual" | "mailbox";
      request_status:
        | "new"
        | "parsing"
        | "needs_review"
        | "reviewed"
        | "rfqs_drafted"
        | "rfqs_sent"
        | "collecting"
        | "comparing"
        | "sourced"
        | "closed";
      rfq_status: "draft" | "queued" | "sent" | "failed" | "responded" | "declined" | "closed";
      vendor_type: "mill" | "service_center" | "broker" | "other";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      alias_source: ["seed", "learned"],
      alternate_type: ["grade", "dimension", "wall", "length"],
      availability: ["stock", "rolling", "unknown"],
      freight_basis: ["included", "separate", "unknown"],
      freight_default: ["quoted", "arranged", "fob", "unknown"],
      line_unit: ["pcs", "ft", "in", "lbs", "cwt", "tons", "sqft"],
      matched_by: ["thread", "manual", "ai", "none"],
      material_category: [
        "hss_square",
        "hss_rectangular",
        "hss_round",
        "pipe",
        "w_beam",
        "s_beam",
        "channel",
        "angle",
        "flat_bar",
        "round_bar",
        "square_bar",
        "plate",
        "sheet",
        "rebar",
      ],
      member_role: ["owner", "admin", "member"],
      message_direction: ["in", "out"],
      offer_source: ["email", "pdf", "phone", "text", "manual"],
      offer_status: ["parsed", "reviewed", "declined"],
      price_basis: ["per_cwt", "per_lb", "per_ft", "per_pc", "per_ton", "per_sqft"],
      request_line_status: ["parsed", "confirmed", "custom", "removed"],
      request_source_type: ["paste", "eml", "manual", "mailbox"],
      request_status: [
        "new",
        "parsing",
        "needs_review",
        "reviewed",
        "rfqs_drafted",
        "rfqs_sent",
        "collecting",
        "comparing",
        "sourced",
        "closed",
      ],
      rfq_status: ["draft", "queued", "sent", "failed", "responded", "declined", "closed"],
      vendor_type: ["mill", "service_center", "broker", "other"],
    },
  },
} as const;
