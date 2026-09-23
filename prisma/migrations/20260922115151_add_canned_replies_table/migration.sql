-- CreateTable
CREATE TABLE "canned_replies" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canned_replies_pkey" PRIMARY KEY ("id")
);

-- Seed the four defaults (ANNOUNCE-API-5 D-4), byte-equal to the former hardcoded
-- easybook-app CannedRepliesCard.tsx REPLIES. Fixed ids; never re-run (Prisma records the migration).
INSERT INTO "canned_replies" ("id", "title", "text", "sortOrder", "createdAt", "updatedAt")
VALUES
    ('canned_reply_default_1', 'แจ้งวิธีจองสถานที่', 'สวัสดีค่ะ จองสถานที่ได้ที่เมนู "จองสถานที่" ด้านล่างห้องแชทนี้ เลือกสถานที่ วันและเวลา แล้วกดยืนยัน ระบบจะแจ้งผลการอนุมัติทาง LINE ภายใน 1 วันทำการค่ะ', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('canned_reply_default_2', 'แจ้งเงื่อนไขการยกเลิก', 'ยกเลิกการจองได้เองที่เมนู "การจองของฉัน" ก่อนเวลาใช้งานอย่างน้อย 24 ชั่วโมง หากน้อยกว่านั้นกรุณาติดต่อเจ้าหน้าที่ผ่านแชทนี้ค่ะ', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('canned_reply_default_3', 'แจ้งสถานะคำขอรออนุมัติ', 'ได้รับคำขอจองของท่านแล้วค่ะ ขณะนี้อยู่ระหว่างรอเจ้าหน้าที่อนุมัติ เมื่อพิจารณาแล้วระบบจะแจ้งผลให้ทราบทาง LINE โดยอัตโนมัติค่ะ', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('canned_reply_default_4', 'ติดต่อนอกเวลาทำการ', 'ขอบคุณที่ติดต่อมาค่ะ ขณะนี้อยู่นอกเวลาทำการ (จันทร์–ศุกร์ 08:30–16:30 น.) เจ้าหน้าที่จะตอบกลับโดยเร็วที่สุดในวันทำการถัดไปค่ะ', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
