CREATE TABLE "payroll_rate_card_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_name" text NOT NULL,
	"effective_month" date NOT NULL,
	"source_label" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_rate_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"student_band" text NOT NULL,
	"curriculum" text NOT NULL,
	"course" text NOT NULL,
	"normalized_course_key" text NOT NULL,
	"tier_key" text NOT NULL,
	"source_tier_key" text NOT NULL,
	"price_per_hour" double precision,
	"expected_revenue_per_hour" double precision NOT NULL,
	"revenue_share" double precision,
	"raw_source_row" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_rate_rules" ADD CONSTRAINT "payroll_rate_rules_version_id_payroll_rate_card_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."payroll_rate_card_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_rate_card_versions_active_idx" ON "payroll_rate_card_versions" USING btree ("active") WHERE "payroll_rate_card_versions"."active" = true;
--> statement-breakpoint
CREATE INDEX "payroll_rate_card_versions_effective_idx" ON "payroll_rate_card_versions" USING btree ("effective_month");
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_rate_rules_unique_idx" ON "payroll_rate_rules" USING btree ("version_id","student_band","normalized_course_key","tier_key");
--> statement-breakpoint
CREATE INDEX "payroll_rate_rules_lookup_idx" ON "payroll_rate_rules" USING btree ("version_id","student_band","normalized_course_key");
--> statement-breakpoint
WITH rate_card_version AS (
	INSERT INTO "payroll_rate_card_versions" ("version_name", "effective_month", "source_label", "active", "created_by_email", "metadata")
	VALUES (
		'PayRate May 2026',
		'2026-05-01',
		'Google Sheet PayRate gid 157734374',
		true,
		'codex@local',
		'{"spreadsheetId":"1xwbaLzyceUSNMUhhIBLV4j7uG3cRIqFKwJUfYZE_vG4","sheetName":"PayRate"}'::jsonb
	)
	RETURNING "id"
),
source_rows ("student_band", "curriculum", "course", "normalized_course_key", "price_per_hour", "tier_0_1", "tier_0_2", "tier_1", "tier_2", "tier_3") AS (
	VALUES
	('1','UK/US/IB','Year 2-8 or Grade 1-7','year_2_8_grade_1_7',1200,NULL,NULL,600,500,400),
	('1','UK/US/IB','Year 2-8 or Grade 1-7 | Master Class','year_2_8_grade_1_7_master',2000,NULL,1000,NULL,NULL,NULL),
	('1','UK/US/IB','Year 9-11 or Grade 8-10','year_9_11_grade_8_10',1400,NULL,NULL,700,600,500),
	('1','UK/US/IB','Year 9-11 or Grade 8-10 | Master Class','year_9_11_grade_8_10_master',2000,NULL,1000,NULL,NULL,NULL),
	('1','UK/US/IB','Year 12-13 or Grade 11-12','year_12_13_grade_11_12',1600,NULL,NULL,800,700,600),
	('1','UK/US/IB','Year 12-13 or Grade 11-12 | Master Class','year_12_13_grade_11_12_master',2000,NULL,1000,NULL,NULL,NULL),
	('1','UK/US/IB','University Level','university_level',2500,NULL,NULL,1250,1000,800),
	('1','UK/US/IB','University Level | Master Class','university_level_master',2500,NULL,1250,NULL,NULL,NULL),
	('1','UK/US/IB','English Master Class','english_master_class',3000,1500,NULL,NULL,NULL,NULL),
	('1','Thai/EP','Grade 1-9','grade_1_9',1200,NULL,NULL,600,500,400),
	('1','Thai/EP','Grade 1-9 | Master Class','grade_1_9_master',2000,NULL,1000,NULL,NULL,NULL),
	('1','Thai/EP','Grade 10-12','grade_10_12',1400,NULL,NULL,700,600,500),
	('1','Thai/EP','Grade 10-12 | Master Class','grade_10_12_master',2000,NULL,1000,NULL,NULL,NULL),
	('1','International Exam Prep','Admission Exam Prep 11+/13+','admission_exam_prep_11_13',1400,NULL,NULL,700,600,500),
	('1','International Exam Prep','Admission Exam Prep 11+/13+ | Master Class','admission_exam_prep_11_13_master',2000,NULL,1000,NULL,NULL,NULL),
	('1','International Exam Prep','Admission Exam Prep 16+','admission_exam_prep_16',1600,NULL,NULL,800,700,600),
	('1','International Exam Prep','Admission Exam Prep 16+ | Master Class','admission_exam_prep_16_master',2000,NULL,1000,NULL,NULL,NULL),
	('1','International Exam Prep','GED','ged',1400,NULL,NULL,700,600,500),
	('1','International Exam Prep','GED | Master Class','ged_master',2000,NULL,1000,NULL,NULL,NULL),
	('1','International Exam Prep','SAT','sat',1400,NULL,NULL,700,600,500),
	('1','International Exam Prep','SAT | Master Class','sat_master',2000,NULL,1000,NULL,NULL,NULL),
	('1','International Exam Prep','IELTS','ielts',1600,NULL,NULL,800,700,600),
	('1','International Exam Prep','IELTS | Master Class','ielts_master',2000,NULL,1000,NULL,NULL,NULL),
	('1','Additional','Critical Thinking','critical_thinking',3000,NULL,1500,NULL,NULL,NULL),
	('1','Additional','IGCSE Pathway','igcse_pathway',NULL,NULL,NULL,NULL,NULL,NULL),
	('1','Additional','Interview Prep','interview_prep',3600,1800,NULL,NULL,NULL,NULL),
	('2','UK/US/IB','Year 2-8 or Grade 1-7','year_2_8_grade_1_7',1000,NULL,NULL,900,750,600),
	('2','UK/US/IB','Year 2-8 or Grade 1-7 | Master Class','year_2_8_grade_1_7_master',1700,NULL,1500,NULL,NULL,NULL),
	('2','UK/US/IB','Year 9-11 or Grade 8-10','year_9_11_grade_8_10',1200,NULL,NULL,1050,900,750),
	('2','UK/US/IB','Year 9-11 or Grade 8-10 | Master Class','year_9_11_grade_8_10_master',1700,NULL,1500,NULL,NULL,NULL),
	('2','UK/US/IB','Year 12-13 or Grade 11-12','year_12_13_grade_11_12',1300,NULL,NULL,1200,1050,900),
	('2','UK/US/IB','Year 12-13 or Grade 11-12 | Master Class','year_12_13_grade_11_12_master',1700,NULL,1500,NULL,NULL,NULL),
	('2','UK/US/IB','University Level','university_level',2000,NULL,NULL,1875,1500,1200),
	('2','UK/US/IB','University Level | Master Class','university_level_master',2000,NULL,1875,NULL,NULL,NULL),
	('2','UK/US/IB','English Master Class','english_master_class',2500,2250,NULL,NULL,NULL,NULL),
	('2','Thai/EP','Grade 1-9','grade_1_9',1000,NULL,NULL,900,750,600),
	('2','Thai/EP','Grade 1-9 | Master Class','grade_1_9_master',1700,NULL,1500,NULL,NULL,NULL),
	('2','Thai/EP','Grade 10-12','grade_10_12',1200,NULL,NULL,1050,900,750),
	('2','Thai/EP','Grade 10-12 | Master Class','grade_10_12_master',1700,NULL,1500,NULL,NULL,NULL),
	('2','International Exam Prep','Admission Exam Prep 11+/13+','admission_exam_prep_11_13',1200,NULL,NULL,1050,900,750),
	('2','International Exam Prep','Admission Exam Prep 11+/13+ | Master Class','admission_exam_prep_11_13_master',1700,NULL,1500,NULL,NULL,NULL),
	('2','International Exam Prep','Admission Exam Prep 16+','admission_exam_prep_16',1300,NULL,NULL,1200,1050,900),
	('2','International Exam Prep','Admission Exam Prep 16+ | Master Class','admission_exam_prep_16_master',1700,NULL,1500,NULL,NULL,NULL),
	('2','International Exam Prep','GED','ged',1200,NULL,NULL,1050,900,750),
	('2','International Exam Prep','GED | Master Class','ged_master',1700,NULL,1500,NULL,NULL,NULL),
	('2','International Exam Prep','SAT','sat',1200,NULL,NULL,1050,900,750),
	('2','International Exam Prep','SAT | Master Class','sat_master',1700,NULL,1500,NULL,NULL,NULL),
	('2','International Exam Prep','IELTS','ielts',1300,NULL,NULL,1200,1050,900),
	('2','International Exam Prep','IELTS | Master Class','ielts_master',1700,NULL,1500,NULL,NULL,NULL),
	('3_plus','UK/US/IB','Year 2-8 or Grade 1-7','year_2_8_grade_1_7',900,NULL,NULL,1080,900,720),
	('3_plus','UK/US/IB','Year 2-8 or Grade 1-7 | Master Class','year_2_8_grade_1_7_master',1500,NULL,1800,NULL,NULL,NULL),
	('3_plus','UK/US/IB','Year 9-11 or Grade 8-10','year_9_11_grade_8_10',1000,NULL,NULL,1260,1080,900),
	('3_plus','UK/US/IB','Year 9-11 or Grade 8-10 | Master Class','year_9_11_grade_8_10_master',1500,NULL,1800,NULL,NULL,NULL),
	('3_plus','UK/US/IB','Year 12-13 or Grade 11-12','year_12_13_grade_11_12',1200,NULL,NULL,1440,1260,1080),
	('3_plus','UK/US/IB','Year 12-13 or Grade 11-12 | Master Class','year_12_13_grade_11_12_master',1500,NULL,1800,NULL,NULL,NULL),
	('3_plus','UK/US/IB','University Level','university_level',1800,NULL,NULL,2250,1800,1440),
	('3_plus','UK/US/IB','University Level | Master Class','university_level_master',1800,NULL,2250,NULL,NULL,NULL),
	('3_plus','UK/US/IB','English Master Class','english_master_class',2300,2700,NULL,NULL,NULL,NULL),
	('3_plus','Thai/EP','Grade 1-9','grade_1_9',900,NULL,NULL,1080,900,720),
	('3_plus','Thai/EP','Grade 1-9 | Master Class','grade_1_9_master',1500,NULL,1800,NULL,NULL,NULL),
	('3_plus','Thai/EP','Grade 10-12','grade_10_12',1000,NULL,NULL,1260,1080,900),
	('3_plus','Thai/EP','Grade 10-12 | Master Class','grade_10_12_master',1500,NULL,1800,NULL,NULL,NULL),
	('3_plus','International Exam Prep','Admission Exam Prep 11+/13+','admission_exam_prep_11_13',1000,NULL,NULL,1260,1080,900),
	('3_plus','International Exam Prep','Admission Exam Prep 11+/13+ | Master Class','admission_exam_prep_11_13_master',1500,NULL,1800,NULL,NULL,NULL),
	('3_plus','International Exam Prep','Admission Exam Prep 16+','admission_exam_prep_16',1200,NULL,NULL,1440,1260,1080),
	('3_plus','International Exam Prep','Admission Exam Prep 16+ | Master Class','admission_exam_prep_16_master',1500,NULL,1800,NULL,NULL,NULL),
	('3_plus','International Exam Prep','GED','ged',1000,NULL,NULL,1260,1080,900),
	('3_plus','International Exam Prep','GED | Master Class','ged_master',1500,NULL,1800,NULL,NULL,NULL),
	('3_plus','International Exam Prep','SAT','sat',1000,NULL,NULL,1260,1080,900),
	('3_plus','International Exam Prep','SAT | Master Class','sat_master',1500,NULL,1800,NULL,NULL,NULL),
	('3_plus','International Exam Prep','IELTS','ielts',1200,NULL,NULL,1440,1260,1080),
	('3_plus','International Exam Prep','IELTS | Master Class','ielts_master',1500,NULL,1800,NULL,NULL,NULL)
),
expanded AS (
	SELECT
		rate_card_version."id" AS "version_id",
		source_rows."student_band",
		source_rows."curriculum",
		source_rows."course",
		source_rows."normalized_course_key",
		tier_data."tier_key",
		tier_data."source_tier_key",
		source_rows."price_per_hour",
		tier_data."expected_revenue_per_hour",
		CASE
			WHEN source_rows."price_per_hour" IS NULL THEN NULL
			WHEN source_rows."student_band" = '2' THEN tier_data."expected_revenue_per_hour" / (source_rows."price_per_hour" * 2)
			WHEN source_rows."student_band" = '3_plus' THEN tier_data."expected_revenue_per_hour" / (source_rows."price_per_hour" * 3)
			ELSE tier_data."expected_revenue_per_hour" / source_rows."price_per_hour"
		END AS "revenue_share",
		tier_data."priority",
		jsonb_build_object(
			'studentBand', source_rows."student_band",
			'curriculum', source_rows."curriculum",
			'course', source_rows."course",
			'sourceTierKey', tier_data."source_tier_key"
		) AS "raw_source_row"
	FROM rate_card_version
	CROSS JOIN source_rows
	CROSS JOIN LATERAL (
		VALUES
		('BG0','Tier 0-1',source_rows."tier_0_1",2),
		('BG1','Tier 0-1',source_rows."tier_0_1",2),
		('BG0','Tier 0-2',source_rows."tier_0_2",1),
		('BG1','Tier 0-2',source_rows."tier_0_2",1),
		('BG2','Tier 0-2',source_rows."tier_0_2",1),
		('BG1','Tier 1',source_rows."tier_1",3),
		('BG2','Tier 2',source_rows."tier_2",3),
		('BG3','Tier 3',source_rows."tier_3",3)
	) AS tier_data("tier_key", "source_tier_key", "expected_revenue_per_hour", "priority")
	WHERE tier_data."expected_revenue_per_hour" IS NOT NULL
),
ranked AS (
	SELECT DISTINCT ON ("version_id", "student_band", "normalized_course_key", "tier_key")
		"version_id",
		"student_band",
		"curriculum",
		"course",
		"normalized_course_key",
		"tier_key",
		"source_tier_key",
		"price_per_hour",
		"expected_revenue_per_hour",
		"revenue_share",
		"raw_source_row"
	FROM expanded
	ORDER BY "version_id", "student_band", "normalized_course_key", "tier_key", "priority" DESC
)
INSERT INTO "payroll_rate_rules" (
	"version_id",
	"student_band",
	"curriculum",
	"course",
	"normalized_course_key",
	"tier_key",
	"source_tier_key",
	"price_per_hour",
	"expected_revenue_per_hour",
	"revenue_share",
	"raw_source_row"
)
SELECT
	"version_id",
	"student_band",
	"curriculum",
	"course",
	"normalized_course_key",
	"tier_key",
	"source_tier_key",
	"price_per_hour",
	"expected_revenue_per_hour",
	"revenue_share",
	"raw_source_row"
FROM ranked;
